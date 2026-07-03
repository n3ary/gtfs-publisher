# Standards

All standards in this directory are vendored from
[`ciotlosm/neary-shared/standards/`](https://github.com/ciotlosm/neary-shared/tree/main/standards).
The vendored copies carry a `<!-- synced from ciotlosm/neary-shared@<sha> on <date} -->` header.

**Don't edit vendored standards locally.** Edits will be overwritten by the next sync from `neary-shared`. To change a shared standard, edit it in `neary-shared/standards/` instead.

The drift check workflow (`.github/workflows/check-standards-drift.yml`) fails a PR if a vendored copy is out of date with `neary-shared@main`.

## Vendored (from `neary-shared`)

- `agent-worktrees.md`
- `core-principles.md`
- `diagramming.md`
- `documentation.md`
- `issue-plan-lifecycle.md`
- `naming.md`
- `testing.md`
- `verification.md`
- `version-management.md`

## Local

None today. Future feed-pipeline-specific standards (e.g. CSV-encoding rules, ETag-skip semantics) belong here.

## How to sync locally

Wait for the auto-sync PR from `neary-shared@main`, or:

```bash
cd <path-to-neary-shared>
node scripts/vendor-standards.mjs --local /tmp/vendor
cp /tmp/vendor/* docs/standards/
git add docs/standards/
git commit -m "chore(standards): vendor from ciotlosm/neary-shared"
```