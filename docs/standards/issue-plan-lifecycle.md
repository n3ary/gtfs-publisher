<!-- synced from n3ary/standards@4175a47 on 2026-07-11 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Issue vs plan lifecycle

> **One-line rule**: issues are long-lived records of intent on the repo where the code will be written. Plans are short-lived work artifacts on a branch. Plans never live in `main`.

## Core principle

Two distinct things exist in this repo's planning model and they should never get confused:

- **Issue** = "we want to do this someday, may or may not". Lives on the repo where the code will be written. Stays open as long as the owner wants.
- **Plan** = "we are actively working on this; here are the decisions and steps". Lives on a feature branch. Deleted at the end.

A plan that survives the work it was for is a planning artifact that's outlived its purpose. Distill the decisions into specs/concepts/standards, open issues for the unfinished work, then delete the plan.

## When to use which

### Create an issue when

- A new idea emerges and you're not sure if it's worth doing.
- An ideal surfaces mid-implementation but isn't drastic enough to derail the current work.
- You finish a feature and notice unrelated "while I'm here" ideas.
- Someone asks for more details on an existing idea — it stays an issue.
- A previously-shelved idea becomes relevant again.

### Create a plan when

- The owner signals "start implementing" on a complex idea.
- Multiple non-trivial decisions need to be made during the work.
- The implementation has a defined endpoint ("ship this feature").

A plan is not for capturing ideas. It's for executing against them. If you're not actively working against the document, it's not a plan.

## Plan lifecycle

1. **Create on a branch** (usually the feature branch the work lives on, sometimes a dedicated `plan/<slug>` branch).
2. **Update as work proceeds** — the plan reflects current understanding, not original intent.
3. **Implement the plan** — work to its endpoint.
4. **Distill** at completion:
   - Decisions → `docs/specs/` or `docs/concepts/` (permanent docs).
   - Outstanding work that didn't make the cut → new GitHub issue(s) on the right repos.
   - Open questions that landed on one side → note in the relevant spec/concept.
5. **Delete the plan file**. Do not merge the plan to `main`. Do not leave it on a long-lived branch.

A plan that lives more than one implementation cycle is a smell. Either it's still being executed (move to the work branch) or it's done (distill and delete).

## Issue lifecycle

1. **Create when the idea emerges**, regardless of stage.
2. **File on the repo where the code will be written.** If a feature spans two repos, each gets its own issue; cross-link via "blocked by" / "depends on" references.
3. **Keep open** as long as the owner wants. There's no SLA. There's no "stale" review.
4. **Close when**:
   - Implemented (link the closing PR).
   - Fixed (link the fixing PR).
   - Superseded (link the new issue or PR).
   - Explicitly cancelled by the owner.

## Distillation process

When closing a plan after implementation:

For each decision in the plan, write it as a sentence in the relevant spec/concept/standard. For each "not done yet" item, open an issue on the right repo. Then delete the plan file.

Concrete mapping:

| Plan content | Goes to |
|---|---|
| "Why we do X" reasoning | `docs/concepts/` or `docs/standards/` |
| Implementation decisions | `docs/specs/` |
| Folder layout, file structure | `README.md` of the package / repo |
| Cost / deploy numbers | Concept doc if stable; otherwise delete (numbers go stale) |
| "Stage X" / "Stage Y" work in flight | GitHub issue on the right repo |
| Open questions resolved by the work | The relevant spec/concept, with a sentence noting the answer |
| Hypothetical future ideas that surfaced during the work | GitHub issues |

## Issue placement

The gist: file the issue where the code will be written. If a feature spans multiple repos, each repo owns its piece.

| If the work is in... | The issue lives on... |
|---|---|
| This repo (the consumer) | `neary` |
| The producer / adapter pipeline | `neary-gtfs` |
| A separate third-party adapter | That adapter's repo |

Cross-repo coordination goes in the issue description: list the affected repos, link to sister issues on each.

## Anti-patterns

- **Plan in `main`**: violates the lifecycle. Move to a branch or delete after distillation.
- **Plan on a branch for months**: same violation, just slower. Distill and delete, or move to a feature branch with active work.
- **Issue that's secretly a plan**: the "issue" has multiple sections, todos, architecture diagrams, decisions pending. That's a plan — promote to a branch and execute.
- **Plan that's secretly an issue**: the "plan" is just an idea with no active work. Demote to an issue.
- **"We should..." in a closed PR or a comment**: open an issue. If you didn't, the idea disappears.
- **Per-feed quirks as docs**: per-feed facts belong in code (`packages/gtfs-rt/src/quirks/<feed>.ts`), not in this repo's docs. Specs and concepts describe the architecture; quirks describe the data.

## Examples

### New idea → issue → implement → distill

1. "We should add a planner view" → issue #104 ("Planner view: map-first itineraries").
2. Owner says "let's start the planner view" → create branch + plan doc on the branch.
3. Plan executes over weeks; plan doc updates as decisions land.
4. At completion:
   - "How planner integrates with favourites" → distilled into `docs/specs/planner.md` (or wherever it fits).
   - "Add transfer-walking ETA model" → new issue on the same repo.
   - "Investigate itinerary caching" → new issue.
   - Delete the plan doc.

### Mid-implementation ideal

You're shipping PR #159 (cache management). Mid-PR, you realise the size badge should probably also show estimated download time. That's a real but separate idea.

- Not drastic enough to derail PR #159. → **Open an issue.** Don't merge it into PR #159, don't put it in a plan.

### End-of-feature unrelated idea

You finish the cache-delete feature. While writing tests, you notice the Stations view has a related bug. Unrelated to the work you just did.

- → **Open an issue.** Same repo (this is consumer-side).

### Hypothetical / exploratory

"Hmm, what if we ever supported offline-first?" — pure speculation, no code path, no decision pending.

- → **Issue**, with `?` in the title and "exploratory" framing in the body. It can stay open indefinitely without anyone feeling obligated to act.

## Why this matters

Mixing plans and issues is the single biggest source of "where did that idea go" and "what does this doc actually mean anymore?" pain. The cost of cleaning it up is low; the cost of living with a messy tree is high. When in doubt:

- Is anyone working on it? → issue or PR, not plan.
- Has it shipped? → delete the plan, distill to spec, open follow-up issues.
- Still being designed? → plan on a branch with active commits, not in `main`.

## Code comment rules

Code comments in `main` follow stricter rules than docs because they outlive plans and ship with the code:

- **Never reference plans.** Plans are short-lived work artifacts on a branch; a comment in `main` that points at a deleted plan is a broken link, and a comment in a feature branch that references a plan-on-that-branch is fine but only on that branch. Aspirational work belongs in issues, not in source code.
- **Reference issues only when the code is an accepted temporary workaround.** Specifically: the code exists today as a stop-gap that will be deleted when the issue is closed. The comment must name the issue that triggers removal. The TEMP `recoverClujTripFields` block in `src/lib/domain/enrichObservations.ts` is the model — gated on trip_id shape, pointing at the producer-side issue that fixes the upstream.
- **Describe current behaviour, not aspirational work.** Permanent code's docstring explains what the code does today. "Closes Stage B of the prediction-v2 roadmap" is wrong if Stage B isn't closed yet; the code does what it does. Aspirational "we plan to differentiate this kind" comments belong in issues, not in the code that doesn't differentiate it.

The check: every code-comment reference to a `plan/` file, `roadmap`, `Stage X`, or `item N` is a smell. The check: every code-comment reference to `#NNN` should resolve to a temporary workaround whose removal is the issue's resolution. If you can't justify it with one of those, drop the reference.