---
name: getting-started
description: Explain this plugin’s current Skills or help add a new Skill to its source.
---
# Getting started

Inspect the plugin's current Skills before describing it: use `src/skills/` in
the source project and the installed `skills/` directory in an artifact.
Capabilities may have changed since scaffolding. The minimal template starts
with this Skill, one config, and a delivery check.

## How to add a Skill

1. Create `src/skills/<skill-id>/SKILL.md` with `name` and `description`
   frontmatter. The `name` must match the directory name; describe the specific
   task that should activate it, without attracting unrelated requests.
2. Keep useful shared instructions in `SKILL.md`. Add substantial conditional
   detail under `references/` only when needed, linking it with a clear read
   condition. Use `assets/` for templates or files the agent fills in or copies
   into its deliverable; a short Skill needs neither directory.
3. Leave `agent-bundle.config.ts` unchanged unless overriding the conventional
   Skill layout.
4. After adding or changing a Skill, run the project's `check` script: it
   validates the config, builds every host artifact, type-checks, and runs the
   tests.

Keep the workflow within the request and preserve existing authorization.
Avoid mandatory plans, audits, or approval pauses for simple informational
questions. Report the current capabilities or completed edit and validation,
including any concrete limitation.
