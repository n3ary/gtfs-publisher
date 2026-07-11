<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Documentation

Where docs go, what they look like, and what doesn't belong.

## Placement decision

Ask in order:

1. **Is the answer in the code?** → don't write a doc.
2. **Is it a shared term?** → `concepts/`.
3. **Is it a rule the codebase MUST follow?** → `standards/`.
4. **Is it a contract whose reasoning isn't in the code?** → `specs/`.
5. **Is it future work or in-flight design?** → `plan/`.
6. **Is it an empirical analysis or historical artifact?** → `investigation/`.
7. **Is it a system-level diagram or component map?** → `architecture/`.

If none of these match cleanly, the doc probably shouldn't exist.

## What every doc must have

- Title (`# Name`).
- A 1–2 sentence purpose immediately after the title.
- Pointers to source code for anything implementation-specific.
- Cross-references to related docs.

## Diagrams and call-outs

Use Mermaid for every diagram, and GFM admonitions (`> [!NOTE]`, `> [!TIP]`,
`> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`) to flag important content.
`[!CAUTION]` is reserved for **anti-patterns**. Full rules in
[diagramming.md](diagramming.md).

## Code in docs

Quoted source code in a doc is a copy that rots. Aim for pointers, not
pastes:

- **> 6 lines of consecutive fenced source code** (`` ```ts ``,
  `` ```js ``, `` ```svelte ``) in any doc → replace with a relative
  link to the file with a line anchor (e.g.
  `[implementation](src/lib/domain/buckets.ts#L1-L60)`). The doc stays
  focused on *why*, not *what*.
- **Smaller snippets** (<= 6 lines) are OK when the snippet itself IS
  the spec — a GTFS record shape, a JSON contract, a regex pattern, a
  CSS hook. Don't link to the source for things that aren't themselves
  code.
- **Mermaid is preferred over TS for diagrams.** Block diagrams of state
  machines, flow, or data flow go in `` ```mermaid ``, not inlined TS.
  Source code is not a diagram.

Inline-comment policy lives in [comments.md](comments.md).

## What no doc should have

- Restating what the code already says line-by-line.
- Rationale for a fix already in git history ("we used to do X, now we do Y").
- Timelines, dates that will go stale, OKRs.
- Step-by-step tutorials for popular libraries (link to upstream docs).
- Long quoted code blocks (see [Code in docs](#code-in-docs) above).

## Length

- Every directory has a `README.md` index.
- Standard / concept / spec docs target < 100 lines, hard cap 200.
- Plan docs may be longer (they describe future work in detail).

## File naming

- Lowercase kebab-case for content files (`prediction-v2.md`, `arrival-buckets.md`).
- `README.md` is the only uppercase file.
- No spaces, no underscores, no numeric prefixes for ordering.

## Cross-references

- Use relative paths.
- Point to the smallest useful target: file, then section anchor.
- Never link to a parent directory when one file is what you mean.

## What goes in /investigation

- Empirical analyses (e.g. comparing data sources) that informed a decision but won't be updated.
- Frozen v1 docs while the v1 app is still deployed.
- Anything labelled "spike" or "exploration".

Investigation docs are read-only history; they're not the source of truth
for anything current. Move conclusions into `concepts/` or `specs/` and
keep the analysis here for audit trail.

## What gets deleted

- Empty placeholder docs (`changelog.md` with no entries — git log is the changelog).
- Docs whose entire content has been distilled into a `specs/` or `concepts/` file.
- Anything that hasn't been touched in 6 months and no longer reflects the code.
