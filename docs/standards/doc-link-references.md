<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Doc link references

Two kinds of links in our docs and READMEs:

| Kind | Format | Example |
|---|---|---|
| External | full URL | `[pull request](https://github.com/...)` |
| Same-repo | filename only, no path | `[agent-worktrees.md](agent-worktrees.md)` |
| Cross-repo | repo + path, no leading slash | `[n3ary/gtfs#34](https://github.com/n3ary/gtfs/issues/34)` |

## The rule: filename only for same-repo links

When a doc lives in the same repo as the thing it links to, the link target is **just the filename**, not the path. Examples:

- ✅ `[agent-worktrees.md](agent-worktrees.md)`
- ❌ `[agent-worktrees.md](../standards/agent-worktrees.md)`
- ✅ `[feeds-json.md](../specs/feeds-json.md)` — wait, this is **wrong**, the spec lives in a sibling directory, the path traversal is needed.

Correction. The rule is: **the link text equals the link target as it would be opened in the file tree from the link's own location**. So if the doc is in `docs/standards/`, a link to a sibling in `docs/standards/` is `[foo.md](foo.md)`. A link to a doc in `docs/specs/` is `[foo.md](../specs/foo.md)`.

But: **the display text should be the filename, not the path.** Renderers like GitHub's auto-link will show the full path. The display text is for human readers; minimize it.

So:
- ✅ `[foo.md](foo.md)` — text is just the filename
- ❌ `[../standards/foo.md](../standards/foo.md)` — text duplicates the path
- ✅ `../specs/foo.md` — the link target is a relative path; that's fine

## Why

- Reader eyes see only the filename, not the directory tree. Less visual noise.
- Files move between directories over time. Filename-only links break on move; full-path links break on move too. Same outcome, but filename-only is more readable.
- The `../` traversal in a link text duplicates the path structure that's already implicit in the link target.

## Enforce in PR review

Linters don't catch this. Add a manual review checklist item: *"No `../...` at the start of any link text in docs/ or .md files."*
