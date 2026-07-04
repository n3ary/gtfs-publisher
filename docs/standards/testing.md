<!-- synced from n3ary/standards@dee18d2 on 2026-07-04 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Testing

## Scope

- Root validation runs tests in `src/` only.
- Configured via [vitest.config.ts](../../vitest.config.ts).

## Location

- Test file lives next to its source: `foo.ts` → `foo.test.ts`.
- Integration tests that span modules go under the module that owns the
  primary entry point.

## What to test

- Domain modules: yes, always (pure TS, easy to test).
- Stores: yes, when they encode logic; skip pure passthroughs.
- Components: only when behavior isn't obvious from the markup. Skip
  trivial render tests.
- Workers: smoke test the boundary, not the SQLite engine.

## What NOT to test

- Vendor libraries (SQLite-WASM, Leaflet, Svelte itself).
- Trivial getters/setters.
- Implementation details that change every refactor.

## Size targets

- Unit test: < 50 ms.
- Integration test: < 500 ms.
- Full suite: < 30 s.

If a test gets close to these limits, the test (not the budget) is wrong.

## Property-based tests

Use sparingly. Worth it for combinatorial functions (bucket logic, time
math, schedule matching). Avoid for I/O-heavy or stateful code.

## CI

`npm run check && npm test && npm run build` is what PR validation runs.
Local equivalent must pass before push.
