<!-- synced from n3ary/standards@dee18d2 on 2026-07-04 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Core principles

## Simplicity first

- Default to the simplest solution that works.
- A direct call beats a service layer for a single use.
- Add abstraction at the third real use, not the first.

## Reuse before write

- Before writing a new helper, grep for one that already exists.
- Consolidate at 3+ uses with the same shape; don't pre-extract for 2.

## Clean separation

- UI files (`src/lib/ui/`, `src/routes/`) handle layout and events only.
- Domain files (`src/lib/domain/`) are pure TS, framework-free, unit-tested.
- Workers (`src/lib/workers/`, `src/lib/data/live/`) own all heavy work.
- A change in any one layer should not force changes in the other two for
  things unrelated to the change.

## Code is the source of truth

- If behavior is in the code, don't restate it in docs.
- Docs capture: vocabulary, design reasoning, decisions, future plans, contracts that cross layers.
- When code and docs disagree, the code is right; the doc gets fixed.

## File size

- Split files at ~300 lines when there's a natural boundary.
- Don't split for the sake of splitting — small modules with one
  consumer add navigation cost.
