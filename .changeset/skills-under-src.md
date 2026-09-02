---
"agent-bundle": minor
---

Move conventional authored documents under `src/`: skills now use `src/skills/`, commands use `src/commands/`, and rules use `src/rules/`. Top-level conventional documents are no longer discovered and report AB4736 unless a legacy skill is claimed by explicit `skills` configuration. Explicit skill paths remain supported anywhere, and published artifact paths are unchanged.
