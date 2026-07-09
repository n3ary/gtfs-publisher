# `ops/hetzner/` - runtime configs for the GTFS-RT Hetzner VM

Everything in this directory is **deploy-side** - files that get
copied onto the host (or a fresh VM) to run the `gtfs-rt`
container. The repo-stay is purely so the configs are versioned
alongside the artifact they're for; the contents are still
target-specific (currently Hetzner CX23 with systemd + podman).

| File | Purpose | Installed at |
|---|---|---|
| `firewall.sh` | Hetzner Cloud Firewall bootstrap. Fetches the current CF edge IP ranges (IPv4 + IPv6) from `https://api.cloudflare.com/client/v4/ips` at run time and applies the rules via `hcloud firewall create` / `replace-rules`. Re-run when CF adds an edge range (CF posts to their changelog). | Hetzner Cloud (network-layer; not on the VM) |

The single bootstrap script (`install.sh`) lives in
[`apps/gtfs-rt/config/install.sh`](../gtfs-rt/config/install.sh) -
that's the one the operator runs on the host. It installs podman,
copies the systemd unit + env file into place, and enables the
service. The unit maps host port 80 -> container 8080 via
`podman run -p 80:8080`, so Cloudflare's default port 80 reaches
the Fastify origin with no iptables.

That's the entry point for "rebuild a Hetzner server from
scratch" - `install.sh` is idempotent and meant to be the single
command you run on a fresh VM.

## First-boot order (manual provision)

1. `apt-get update && apt-get -y install git`
2. `git clone https://github.com/n3ary/gtfs-publisher.git && cd gtfs-publisher`
3. (Optional) `export IMAGE=ghcr.io/n3ary/gtfs-rt:sha-<hex>` to pin
4. `bash apps/gtfs-rt/config/install.sh` - installs podman, copies the systemd unit + env, enables the service
5. `curl -sSf http://127.0.0.1/healthz` - should return 200 JSON (host port 80 -> container 8080)

For automated provisioning, the [rebuild-gtfs-rt-vm workflow](../.github/workflows/rebuild-gtfs-rt-vm.yml)
does steps 1-5 for you (creates the VM via `hcloud`, copies the
config, runs `install.sh`, verifies `/healthz`) and additionally
swaps the DNS A record over to the new VM.

## Smoke test from the public internet

```bash
curl -sI https://gtfs-rt.n3ary.com/rt/cluj-napoca/vehicle_positions
# expect: HTTP/2 200, content-type: application/x-protobuf,
# cache-control: public, max-age=5, cf-cache-status: MISS (first call) -> HIT (within 5s)
```

## Resilience model (no floating IP)

The Hetzner Cloud Floating IP was previously used as a "swap target"
- rebuild a new VM, attach the FIP, the public IP never changes. We
dropped the FIP for cost + simplicity: the public hostname
(`gtfs-rt.n3ary.com`) resolves to the VM's primary IPv4 directly,
and a VM swap is a CF DNS A-record update instead of a hypervisor-
level FIP reassign.

The CF cache rule (5 s TTL, see n3ary/app#74) absorbs the swap:
during the ~5 s window where the new VM is being bootstrapped and
the DNS record is being PATCHed, CF keeps serving the previous
snapshot to clients. Once the new VM's `/healthz` is 200, the DNS
record is updated; CF picks it up within seconds; clients see one
round of "miss + stale fetch + live" instead of an outage.

Three GitHub Actions workflows plus one on-VM timer implement the
resilience flow:

| Component | Trigger | Action |
|---|---|---|
| `build-gtfs-rt.yml` | push to main (paths filtered to rt app), `gtfs-rt-v*` tag, manual | Build the container image and push to `ghcr.io/n3ary/gtfs-rt` with `:latest` + `:sha-<12hex>` tags. |
| `deploy-gtfs-rt.yml` | workflow_run from build, manual | SSH to the active VM, `podman pull :latest`, retag to `localhost/gtfs-rt:latest`, restart the systemd unit. Waits for the OCI HEALTHCHECK status (or `/healthz` curl fallback) to be `healthy`. On failure, restores the previous image and fails the pipeline. |
| `rebuild-gtfs-rt-vm.yml` | workflow_dispatch, manual | Create a new CX23, run `install.sh`, swap the CF DNS A record, delete the old VM, then trigger `deploy-gtfs-rt` to refresh `:latest`. |
| `neary-gtfs-rt-healthcheck.{service,timer}` | systemd timer, hourly on the VM itself | Probes `/healthz`; if non-200, restarts the systemd unit. Does NOT trigger a VM rebuild - this is a "wedged container self-heal", not a replacement. Zero GH Action minutes. |

### Deploy health check + rollback (deploy-gtfs-rt.yml)

The deploy job does NOT trust a single "200 OK" response from
`/healthz`. It checks the OCI HEALTHCHECK status (when defined
in the image) or `/healthz` as fallback, polled at 3 s intervals
for up to 90 s. The exact sequence:

1. **Pre-check**: probe the current container. If it's healthy,
   snapshot its image as `localhost/gtfs-rt:previous-<short-sha>`
   (a backup tag we can roll back to).
2. **Deploy**: `podman pull`, retag to `localhost/gtfs-rt:latest`,
   `systemctl restart neary-gtfs-rt`.
3. **Health-check loop**: poll the OCI HEALTHCHECK status (or curl
   `/healthz`) every 3 s for up to 90 s. If `healthy`, done.
4. **On failure with a backup**: retag the backup to
   `localhost/gtfs-rt:latest`, restart, wait 30 s for healthy.
   The service is restored to the previous version, but the
   pipeline still fails (`exit 1`) so the operator notices the
   broken image and can roll the source back.
5. **On failure with no backup** (previous was already unhealthy):
   just fail loudly. We never restore a known-bad image.

### On-VM hourly timer (neary-gtfs-rt-healthcheck.timer)

Installed by `install.sh` via `systemctl enable --now`. Runs the
`neary-gtfs-rt-healthcheck.sh` script every hour. The script
probes `/healthz`; on failure, restarts the systemd unit. No
external dependencies - this is the smallest possible hammer that
clears a wedged container (transient OOM kill, podman lockup,
etc.). It does NOT trigger a rebuild and does NOT call out to
GitHub. Zero GH Action minutes consumed.

A rebuild of the VM is only triggered when:
- the deploy job itself fails (operator's manual `workflow_dispatch`
  on `rebuild-gtfs-rt-vm.yml`), OR
- the operator decides the on-VM timer hasn't recovered the
  service and runs `gh workflow run rebuild-gtfs-rt-vm.yml
  -f reason=...` from the workstation.

This split exists because GH Actions minutes cost money (2000
min/month free for private repos, then billed) and a per-minute
rebuild workflow on a wedged VM would burn through that budget
fast. The on-VM timer is free; rebuild is paid for only when
escalation is actually warranted.

Required repo secrets / variables:

| Name | Type | Used by | Notes |
|---|---|---|---|
| `HCLOUD_TOKEN` | secret | rebuild-vm | Hetzner Cloud API token with project read+write. |
| `HETZNER_SSH_KEY` | secret | deploy, rebuild-vm | Private SSH key. Registered in Hetzner project (the public half is in `HETZNER_SSH_PUBLIC_KEY`). |
| `GHCR_TOKEN` | secret | build, deploy | github PAT with `packages:read` (deploy) or `packages:write` (build) on the n3ary org. |
| `CLOUDFLARE_API_TOKEN` | secret | rebuild-vm | CF API token with Zone DNS edit for n3ary.com. |
| `HETZNER_SSH_PUBLIC_KEY` | variable | rebuild-vm | Public half of the same SSH key. Used to compute the fingerprint that `hcloud server create --ssh-key` accepts. Not sensitive - the public half is already stored in the Hetzner project. |
| `HETZNER_HOST` | variable | deploy | Hostname the deploy job SSHes to. Defaults to `gtfs-rt.n3ary.com` if unset. A hostname is preferred over a raw IP because the rebuild workflow updates the DNS A record; the deploy job always lands on the active VM. |
| `CLOUDFLARE_ZONE_ID` | variable | rebuild-vm | n3ary.com zone id (currently `12fbec52c5a7ee6f7d14ba669a2862cb`). Public value, just inconvenient to hardcode. |
| `CLOUDFLARE_GTFS_RT_A_RECORD_ID` | variable | rebuild-vm | `gtfs-rt.n3ary.com` A record id (currently `4aa2a22f67a93c1dac9394fa6bbf89af`). Public value. |

Hardcoded defaults (no GH config needed):

| Name | Used by | Default |
|---|---|---|
| `HETZNER_SSH_USER` | deploy, rebuild-vm | `root`. The systemd unit runs as root because podman needs `CAP_NET_BIND_SERVICE` to bind port 80; the SSH session has to match. |
| `HETZNER_FIREWALL_NAME` | rebuild-vm | `neary-gtfs-rt-01-edge-only`. The firewall id created by `ops/hetzner/firewall.sh`. |

### Generating the SSH key pair (one-time, per environment)

A **dedicated deploy key** is strongly recommended over sharing your
personal SSH key. If the GH secret ever leaks, a dedicated key only
gives the attacker access to the gtfs-rt VM, not your workstation.

```bash
# 1. Generate the key on your workstation.
#    -t ed25519: short, fast, modern.
#    -N '' : no passphrase. CI cannot prompt; the private key IS the secret.
ssh-keygen -t ed25519 \
  -C 'github-actions-deploy-gtfs-rt' \
  -f ~/.ssh/hetzner-deploy -N ''

# 2. Register the PUBLIC key at Hetzner project level. The CLI form
#    is scriptable + auditable; the Console form is at
#    https://console.hetzner.cloud -> Project -> Security -> SSH keys.
hcloud ssh-key create \
  --name github-actions-deploy-gtfs-rt \
  --public-key-from-file ~/.ssh/hetzner-deploy.pub

# 3. Add the public key to the existing live VM via your personal
#    key. Both keys can coexist in /root/.ssh/authorized_keys.
ssh-copy-id -i ~/.ssh/hetzner-deploy.pub root@78.46.162.131

# 4. Verify the new key works before wiring GH Actions.
ssh -i ~/.ssh/hetzner-deploy root@78.46.162.131 echo ok

# 5. Wire into GH Actions. -R flag works from any cwd; the bare
#    `gh secret set` requires you to be inside the repo.
gh secret set HETZNER_SSH_KEY \
  --repo n3ary/gtfs-publisher < ~/.ssh/hetzner-deploy
gh variable set HETZNER_SSH_PUBLIC_KEY \
  --repo n3ary/gtfs-publisher < ~/.ssh/hetzner-deploy.pub

# 6. Verify both are set (without leaking the secret value).
gh secret list  --repo n3ary/gtfs-publisher | grep HETZNER_SSH_KEY
gh variable list --repo n3ary/gtfs-publisher | grep HETZNER_SSH_PUBLIC_KEY
```

Key rotation (annual or after any suspected compromise): generate a
new key alongside the old one, register the new public key at
Hetzner, add it to all existing VMs, update GH side, test, then
remove the old key from Hetzner + VMs. Full rotation procedure in
the conversation log; in short the cutover has zero downtime
because two SSH keys can coexist on a single VM and at a single
Hetzner project.

**Hygiene rules** (apply every time):

- Never `cat` the private key in a terminal, paste in chat, commit
  to a repo, store in `/tmp`, store in MEMORY.md, or put in a PR
  body / commit message.
- `chmod 600` on the private key file.
- GH Secrets is encrypted at rest; that is the storage layer for
  the private key. macOS keychain is acceptable for local copies.
- Audit before reporting done: grep outputs for the key fingerprint.
  Real ed25519 keys are 68 base64 chars starting with
  `AAAAC3NzaC1lZDI1NTE5AAAA`. Placeholders like `xxxxxxxxxxxxxxxx`
  are obviously fake; if you see one in your output, something
  went wrong upstream.

### Manual recovery

If the cron healthcheck is broken or you want to force a rebuild
without waiting for the second failure, trigger the workflow
directly:

```bash
gh workflow run rebuild-gtfs-rt-vm.yml -f reason='manual ssh failure'
```

For a fresh deploy without a code change (e.g. to pick up a new
ad-hoc image tag), trigger `deploy-gtfs-rt` with a specific tag:

```bash
gh workflow run deploy-gtfs-rt.yml -f image_tag=sha-abc123def456
```

## Hetzner Cloud Firewall

Built and applied by `ops/hetzner/firewall.sh`. The script fetches
the current Cloudflare edge IP ranges (IPv4 + IPv6) from
`https://api.cloudflare.com/client/v4/ips` at run time and applies
the resulting rules via `hcloud firewall create` / `replace-rules`.
A static rules file would go stale silently when CF adds a new
edge range - the script re-fetches on every invocation, so
re-running it is enough to refresh.

Inbound:
- tcp/22 from `$SSH_IP/32` (the operator's current home IPv4 - see
  rotation procedure below). A second source can be added with
  `SSH_IP_2=...` (e.g. a second home, a VPN exit).
- tcp/80 + tcp/443 from the live CF edge IP ranges (the
  orange-cloud proxy). Other source IPs are blocked at the network
  layer.
- icmp from anywhere (ping).

Outbound: 80/443/53/icmp to anywhere (ghcr.io pull, apt, DNS).
Everything else is blocked.

The firewall sits at the Hetzner edge - it's a *network-layer*
control. The CF edge always reaches the VM via the VM's primary
IPv4 on port 80 (or :443 if you set SSL=full_strict on the zone
instead of `full`). Podman's `-p 80:8080` then forwards that into
the container.

### Usage

```bash
# pre-reqs: hcloud CLI authenticated, jq installed
bash ops/hetzner/firewall.sh                                    # uses default server + SSH_IP=78.97.175.93
HCLOUD_SERVER_ID=147556356 bash ops/hetzner/firewall.sh         # or by id
hcloud firewall describe neary-gtfs-rt-01-edge-only             # verify
```

### Rotating the SSH source IP (when your ISP gives you a new IP)

The script idempotently calls `hcloud firewall replace-rules` on
every run, so rotation is a one-liner from the workstation you'll
SSH FROM:

```bash
# 1. find your current public IP
curl -sSf https://api.ipify.org
# -> e.g. 78.97.175.93

# 2. re-run firewall.sh with the new IP as SSH_IP
SSH_IP=$(curl -sSf https://api.ipify.org) bash ops/hetzner/firewall.sh

# 3. verify the rule was replaced in place
hcloud firewall describe neary-gtfs-rt-01-edge-only | grep -A3 'port: "22"'
```

The script's built-in default for `SSH_IP` is the operator's home
IPv4 at the time of writing. Pass `SSH_IP=...` to override
without editing the file. If you SSH from a second location, pass
`SSH_IP_2=...` and the rule's source_ips becomes `[IP1/32, IP2/32]`.

Why a one-shot env var instead of editing the script: editing the
script on every rotation churns the repo history with one-line IP
bumps and creates a public-PR trail of your home address. The env
var keeps the repo at "current IP" without exposing your rotations
in git log.