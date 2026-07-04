# Standards

All standards in this directory are vendored from
[`n3ary/standards/standards/`](https://github.com/n3ary/standards/tree/main/standards).
The vendored copies carry a `<!-- synced from n3ary/standards@<sha> on <date} -->` header.

**Don't edit vendored standards locally.** Edits will be overwritten by the next sync from `n3ary/standards`. To change a shared standard, edit it in `n3ary/standards/standards/` instead.

The drift check workflow (`.github/workflows/check-standards-drift.yml`) fails a PR if a vendored copy is out of date with `n3ary/standards@main`.

## Vendored (from `n3ary/standards`)

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

Wait for the auto-sync PR from `n3ary/standards@main`, or:

```bash
cd <path-to-n3ary/standards>
node scripts/vendor-standards.mjs --local /tmp/vendor
cp /tmp/vendor/* docs/standards/
git add docs/standards/
git commit -m "chore(standards): vendor from n3ary/standards"
```