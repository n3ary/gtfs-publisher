# Publishing `@n3ary/neary-gtfs-spec`

The library is published to **GitHub Packages** (org `n3ary`). The full package lifecycle is automated via `.github/workflows/publish-spec.yml`.

## Package URL

```
https://github.com/orgs/n3ary/packages/npm/neary-gtfs-spec
```

Public on GitHub Packages — anyone can `npm install @n3ary/neary-gtfs-spec` after authenticating with a GitHub token (free, no payment).

## Publishing a release

### Option A: workflow_dispatch (recommended for the first cut)

1. Go to https://github.com/n3ary/neary-gtfs/actions/workflows/publish-spec.yml
2. Click "Run workflow"
3. Enter the version, e.g. `0.2.0` or `0.2.0-rc.1` (prerelease tags allowed)
4. The workflow:
   - Bumps `packages/spec/package.json#version`
   - Commits + tags `packages/spec/v0.2.0`
   - Runs `pnpm install --frozen-lockfile` + `pnpm build` + `pnpm test`
   - Calls `npm publish --provenance --access public` against GitHub Packages
   - Pushes the version commit + tag back to `main`

### Option B: tag push

```bash
git tag packages/spec/v0.2.0
git push origin packages/spec/v0.2.0
```

Triggers the same workflow, skipping the version-bump step.

## Consuming from another repo

The consumer needs an `.npmrc` in their project root:

```ini
@n3ary:registry=https://npm.pkg.github.com
```

And authentication. In a CI workflow, use the repo's `GITHUB_TOKEN`:

```yaml
- name: Install
  env:
    NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: npm install
```

For local development, the consumer needs a personal access token with `read:packages` scope. Add to `~/.npmrc`:

```ini
//npm.pkg.github.com/:_authToken=ghp_xxxxxxxxxxxxxxxx
```

Then `npm install @n3ary/neary-gtfs-spec` works.

## First-publish visibility

`packages/spec/package.json#publishConfig.access` is set to `public`. To make the package private after the first publish, change the field to `restricted` (private to the org), then re-publish. The org must allow it (the org admin can enable private packages via Settings → Packages → Package creation).

## Build output that ships

The published tarball contains only `packages/spec/dist/` (TypeScript output). Source `.ts` files and the rest of the monorepo are excluded. To verify, after a publish:

```bash
npm pack @n3ary/neary-gtfs-spec
tar tzf neary-gtfs-spec-0.1.0.tgz | head -20
```

You should see `package/dist/index.js`, `package/dist/schema/`, `package/dist/spec/`, `package/dist/sql/`, and `package/dist/helper/` — no `.ts` sources.

## Why GitHub Packages (not npmjs)?

The four repos (neary, neary-gtfs, n3ary/standards, cluj-napoca-gtfs-adapter) all live in the new `n3ary` GitHub org as private repos. GitHub Packages is the natural registry for that audience. Publishing to npmjs would require a separate npmjs account + a two-factor auth dance + an unverified publisher.
