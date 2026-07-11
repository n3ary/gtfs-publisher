<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Inline comments

Comments exist as AI-orientation scaffolding, not source of truth. This
standard applies to comments inside source files (`.ts`, `.js`,
`.svelte`, `.css`).

## When to comment

Add a comment only when the surrounding code cannot tell the reader
(human or agent) the non-obvious *why*. The comment earns its keep when
it captures one of:

- a hidden constraint or workaround,
- a subtle invariant the types don't enforce,
- a future-removal trigger linked to an upstream issue,
- a sign convention or unit the type system can't express.

If the surrounding code, the type system, or a one-line summary plus
five seconds of file reading recovers the comment's content, the
comment is restatement and should be deleted.

## Length

- One line per comment when possible.
- Multi-line comments earn their keep only when they document a
  non-obvious *why* the type system can't express — and even then,
  prefer extracting a named helper so the code itself reads like the
  comment.

## What to delete

- A comment that restates what the next line of code already says.
- A JSDoc line that paraphrases a field name (e.g. `/** km/h. */`
  over `speedKmh: number`).
- A file-header block listing the file's exports when the export
  list is right below.
- Numbered `(a) / (b) / (c)` markers inside a long branching
  function that just narrate the literal condition on the next line.
  If the function is hard to navigate, extract helpers
  (`isLiveAndDeparting`, `insideDwellTail`) that read like English.
- An issue or PR link to a non-removal-trigger concern. See below.

## Issue/PR links

Do not embed GitHub issue or PR numbers in code comments — they rot
once the issue closes. Two exceptions:

1. **Removal trigger.** The comment is the trigger for removing a
   block of code once issue #N lands in another repo. The link is
   load-bearing for the future maintainer — without it, they don't
   know when the workaround is safe to delete. Use the full URL:
   `https://github.com/<org>/<repo>/issues/N`.
2. **Design rationale.** The comment documents a deliberate
   architectural choice that warrants a link to an ADR or spec.
   Prefer the spec link to the issue link, and write the rationale
   as plain prose so the comment survives even if the spec moves.

## File headers

A `/* */` block at the top of a file describing the module's purpose
is fine when it captures a non-obvious architectural choice.
Otherwise collapse to one line, e.g.

`// module purpose, one sentence. Spec: <link>.`

or delete entirely. Table-style listings of every export restate the
export list and should be removed.

## Numbered breadcrumbs inside long functions

`(a) / (b) / (c)` markers in a chain of `if` blocks are restatement
prose. Delete them. Two valid alternatives:

- Extract helpers named for what they check (`isLiveAndAtStop`,
  `insideDwellHead`, `onPeakSchedule`) so the call site reads
  plainly.
- Tighten the function so the if-chain is short enough to read
  without markers.

## What does NOT belong in an inline comment

- A walk-through of the entire file. Use a spec doc, not a comment.
- API documentation that duplicates the type signature.
- Tutorial content.
- Code-block diagrams of data flow. Use Mermaid under
  `docs/architecture/` instead.
