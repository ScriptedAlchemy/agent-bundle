---
"agent-bundle": minor
---

Render `.tsx` CLI commands and scripts through the Agent renderer (#102
stage 3). A `src/cli/<command>.tsx` route's async default Server Component
now renders through the runtime dispatcher's public stream against a sibling
react-server worker with four output modes: interactive TTY progress updated
in place, exactly one final Markdown document when piped (no partial
fallbacks), `--json` for the canonical validated final value, and `--ndjson`
for the sequence-numbered render-event stream (a CLI/script dialect, never
written to an MCP stdout). Diagnostics stay on stderr; machine output owns
stdout; exit codes stay deterministic (status- or result-policy-derived,
130/143 on signals reaching the route's `AbortSignal`). Conventional
`src/scripts/<name>.tsx` routes ship the same way with `{ argv, signal }`
component props — lifting the stage-1 `AB4807` gate — while plain `.ts`
scripts and commands keep ordinary Node semantics and never enter the
renderer. The stage-2 `AB4816` gate is retired; the route-unit test harness
now passes rendered CLI/script routes the same props the generated
executables do.
