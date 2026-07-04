<!-- synced from n3ary/standards@ef77e9b on 2026-07-04 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Doc link references

Links in our docs and READMEs are either:

| Kind | Format | Example |
|---|---|---|
| External | full URL, text is usually the URL or a description | `[pull request](https://github.com/n3ary/gtfs/pull/59)` |
| Same-repo, sibling | filename only, no path | `[agent-worktrees.md](agent-worktrees.md)` |
| Same-repo, cross-dir | relative path, **text is just the filename** | `[multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md)` |
| Cross-repo | URL, text is the `<repo>#<id>` or `<repo>:<path>` | `[gtfs#34](https://github.com/n3ary/gtfs/issues/34)` |

## The rule: filename only as link text

When linking to another file in the same repo, **the link text is always just the filename** (without any `../...` prefix). The link target still uses the relative path because that's what the link's own file needs to reach the target.

- ✅ `[multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md)`
- ❌ `[specs/multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md)`

- ✅ `[agent-worktrees.md](agent-worktrees.md)` (sibling, no path needed)
- ❌ `[standards/agent-worktrees.md](agent-worktrees.md)` (path duplicates the target)

## Why

- Reader eyes see only the filename, not the directory tree. Less visual noise.
- The `../` traversal in the text duplicates the path structure that's already implicit in the link target. Doubled.
- The standard is enforced by review, not by linter. Manual checklist item: *"No `../...` at the start of any link text in `*.md` files."*

## Link targets are paths, link text is a name

These are different concerns:

- **Target**: the path or URL that opens when you click. For a file in the same repo, this is a relative path. For a section, an anchor (`#some-section`). For a URL, the full URL.
- **Text**: what the reader sees. Should be the destination's name (filename, section title, repo#id) — never the path.
