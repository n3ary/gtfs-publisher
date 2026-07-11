<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Worktrees

Rules for working on a branch in isolation. Applies to humans and AI
agents (Kilo, Copilot, Cursor, Claude Code, etc.) the same way.

## When you need a worktree

Create one if the task changes anything that lands in a commit on any
branch - code, config, tests, CI, schemas, docs.

Skip it if the task only reads the repo (review, search, explain),
writes only to GitHub issues/discussions via `gh`, or fetches external
context with no repo impact.

If a read-only task pivots mid-flight (e.g. drafting an issue and the
user asks for a PR), stop, create a worktree, and move the work in.

## The lifecycle

Five stages, in order. Pick up at whichever stage you're at; the doc
covers each.

### 1. Spawn the worktree

From the main checkout (assumed to be on `main`):

```bash
cd ~/git/n3ary/app
git fetch origin
git worktree add ~/git/n3ary/app-feat-favorites-station-231 \
  -b feat/favorites-station-231 origin/main
cd ~/git/n3ary/app-feat-favorites-station-231
pnpm install
```

Notes:

- **Path**: `~/git/n3ary/<repo>-<branch-with-slashes-as-dashes>` -
  directory name mirrors the branch name with `/` replaced by `-`.
  `feat/comments-standard` becomes `standards-feat-comments-standard`.
  `feat/api/add-cache` becomes `app-feat-api-add-cache`.
- **Branch name**: `<type>/<kebab-case-slug>` per
  [naming.md](naming.md). Same rule as everywhere else in the org.
- **`pnpm install`** is paid in full per worktree. Don't symlink
  `node_modules` - pnpm's store model puts real symlinks inside
  `node_modules`, and nesting another symlink there breaks hoisting
  and confuses tools that walk up looking for the repo root. The cost
  is real; the footgun is worse.
- **Use the new branch** (`-b <branch>`) when the work is fresh.
  Drop `-b` and pass an existing branch name when picking up a remote
  branch someone else started.

### 2. Do the work

Commit on the worktree branch. Push iteratively if you want CI to see
intermediate states.

```bash
git add -A
git commit -m "feat(favorites): add station favorites"
git push -u origin feat/favorites-station-231   # -u on first push only
```

`main` advances while you work. Sync your branch to it periodically
so the eventual PR stays mergeable.

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease
```

`--force-with-lease` (not `--force`) refuses to overwrite if the
remote branch moved while you were rebasing. Use it every time.

**The `package.json#version` race.** The `pr-validation` workflow
bumps `package.json#version` on the PR branch as a bot commit. When
another PR merges first, `main` advances past your base, and your
rebase will conflict - but only on the version line. Keep the
**higher** version, commit, push.

```text
<<<<<<< HEAD
  "version": "1.5.21",
=======
  "version": "1.5.20",
>>>>>>> origin/main
```

becomes `"version": "1.5.21"`. CI re-runs. No rebase loop.

If the rebase conflicts on anything besides `package.json`, the
parallel shape is wrong - see "When to abort."

### 3. Create the PR

The worktree branch IS the PR branch. Same thing.

```bash
gh pr create --base main --head feat/favorites-station-231 \
  --title "feat(favorites): add station favorites" \
  --body "..."
```

After it opens:

- CI runs on the PR branch. The version bump is one of the checks; it
  commits to the PR branch directly, no agent action needed.
- Push new commits to the same branch to update the PR. No new
  branch, no new PR.
- Review comments are addressed by committing to the same branch.
- `gh pr checks` for CI status; `gh pr view` to read the thread.

### 4. Merge the PR

Once CI is green and review is resolved, merge via GitHub UI or CLI.
The repo settings (see [repo-settings.md](repo-settings.md)) allow
squash and rebase; **squash is the default**.

```bash
gh pr merge --squash --delete-branch
```

`main` advances to include your commits. The remote branch is
auto-deleted by GitHub on merge.

### 5. Clean up the worktree

```bash
git -C ~/git/n3ary/app worktree remove ~/git/n3ary/app-feat-favorites-station-231
git -C ~/git/n3ary/app branch -d feat/favorites-station-231
# Remote branch was already auto-deleted by GitHub on merge.
```

If the PR was closed without merging:

```bash
git -C ~/git/n3ary/app worktree remove ~/git/n3ary/app-feat-favorites-station-231 --force
git -C ~/git/n3ary/app branch -D feat/favorites-station-231
git push origin --delete feat/favorites-station-231   # if not already gone
```

Never delete a branch (local or remote) before its PR is merged or
explicitly closed.

## When to abort and restart on main

Stop using the worktree and consolidate onto the main checkout if any
of these emerges:

- **Hidden coupling surfaces.** The task starts touching files outside
  the leaf it was scoped to (shared schema, lockfile, route table).
- **Every rebase conflicts** beyond `package.json#version`. The
  parallel shape is wrong.
- **`git stash` appears.** Stash is global across worktrees; if
  anyone reaches for it, the isolation is broken.
- **Scope creep.** The agent is editing files outside its assigned
  leaf.

Recovery:

```bash
# Capture the diff (intent) before discarding:
git diff main > /tmp/intent.patch

# Tear down:
git -C ~/git/n3ary/app worktree remove ~/git/n3ary/app-feat-favorites-station-231 --force
git -C ~/git/n3ary/app branch -D feat/favorites-station-231

# Re-apply on the main checkout if you want to continue there:
cd ~/git/n3ary/app
git apply /tmp/intent.patch
```

## How work lands in main

`main` is protected. Every change goes through a PR. Direct commits
and pushes to `main` are forbidden for humans and AI agents.

- **Always open a PR.** Even small fixes; even when you're the only
  maintainer.
- **Linear history.** Squash or rebase merge only. No merge commits.
- **No force-push on `main`.** No branch deletion of `main`.
- **No direct push to `main`.** The PR pipeline catches more than
  people think.

Branch protection is configured per the org-wide standard - see
[repo-settings.md](repo-settings.md) for the exact table.

### Exception: documented automation

There is **no exception** for direct pushes to `main`. CI workflows
respond to events; they don't push to `main`:

- **Dependabot** opens PRs; humans/reviewers merge.
- **Auto-bump version** runs on `pull_request` events and bumps the
  PR branch's `package.json#version`.
- **Deploy workflows** run on `push: branches: [main]` triggers -
  responses to PR merges via the GitHub API, not direct pushes.

If a new automation needs to push to `main`, the rule is: don't add
it. Use a PR.

## Cross-refs

- [naming.md](naming.md) - branch naming reused for worktree
  directory names.
- [repo-settings.md](repo-settings.md) - branch protection, merge
  strategy, why rebase is the sync mechanism.
- [version-management.md](version-management.md) - `package.json#version`
  bumping rules; explains the `git rebase` race in detail.