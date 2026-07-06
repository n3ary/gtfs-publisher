<!-- synced from n3ary/standards@f478439 on 2026-07-06 -->
<!-- do not edit locally; run scripts/vendor-standards.mjs to update -->

# Verification

When stating facts about code, behavior, or state:

1. **Verify before stating.** Read the actual file, run the actual command,
   query the actual store. Don't infer from memory.
2. **State confidence when uncertain.** "I think X" or "the code likely
   does Y" beats a confident wrong answer.
3. **Don't assume the user is right.** If the user says "the X is broken"
   and the code looks fine, ask for the symptom rather than starting a fix.
4. **Cite source paths.** When making a claim about the code, link to the
   file (and line if specific).

These apply to docs, PR descriptions, and any answer an agent gives about
the codebase.
