---
"create-agent-bundle": minor
---

New package: the `create-agent-bundle` scaffolder (RFC #50 Phase 3).
`npm create agent-bundle` / `npx create-agent-bundle` emits a ready-to-run
plugin project from one of three checked-in templates — `minimal`
(skills-only), `mcp-server` (one conventional `src/mcp/<server-id>.ts`
factory entry plus an artifact script), and `cli-tool` (the `src/cli.ts` bin
convention plus a `src/index.ts` library export). Interactive prompts cover
name, template, and host targets, with full non-interactive flags
(`--template`, `--targets`, `--package-manager`, `--no-install`,
`--framework-version`). Scaffolded projects pin `agent-bundle` to the
pkg.pr.new preview of the same commit the scaffolder shipped from, carry a
`check` gate (validate + build + typecheck + test), and validate with zero
diagnostics, including the `AB473x` convention nudges.
