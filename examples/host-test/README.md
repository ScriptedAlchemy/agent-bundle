# Host Test

A probing plugin. Install it into a Claude Code, Codex, or Cursor home, drive
one agent session, and read back exactly what that host sent to every plugin
hook and MCP call — the raw envelope, the framework request context each
handler saw, and the conversation lineage the runtime resolved for it.
It is the acceptance vehicle for `request.lineage` and the evidence source for
`docs/audits/*-host-lineage-matrix.md`.

From the repository root, launch the Workbench with:

```bash
pnpm example:host-test
```

## What the probe records

Every canonical event family the framework admits has a semantic event route
under `src/events/**`, each restricted to the hosts whose pinned capability
table supports it. Every route appends one NDJSON line and dispatches a
bounded summary into the durable state kernel (`src/state.ts`,
`host-test/captures`, workspace-durable). A line carries:

| Field | Contents |
| --- | --- |
| `event.native` | The complete host payload, byte for byte, with secret-looking values replaced by `[redacted]`. |
| `event.canonical` | The framework's canonical identity (`event`, `idempotencyKey`, `observedAt`, `provenance`). |
| `request` | `(await agent())` as the route saw it: `invocation`, `host`, `session`, `actor`, `workspace`, `capabilities`, `lineage`, provider keys, and whether state and notices were mounted. `lineage` is always present: `available` with the resolved tree position, or `unavailable` with the runtime's per-host reason. |
| `ids` | Every identity-shaped native field (`conversation_id`, `generation_id`, `session_id`, `subagent_id`, `tool_call_id`, `agent_id`, `turn_id`, `user_email`, …) lifted out for filtering. |
| `process` | `pid`, `ppid`, `cwd`, `execPath`, entry file, uptime — of the process that ran the route. |
| `runtime` | `shared-runtime` when the hook reached the warm MCP-hosted runtime, `standalone-hook` when it fell back to the hook process, `mcp-server`, or `cli`. |
| `env.names` | Environment variable **names** matching `CURSOR_*`, `CLAUDE_*`, `CODEX_*`, `AGENT_BUNDLE_*`, `PLUGIN_*`, `MCP_*`, `HOST_TEST_*`. Values are never written. |

Two MCP servers ship in the plugin:

- `host-test` (generated routes, `src/mcp/host-test/tools/`): `dump` (filter by
  any conversation/session/subagent id, `full` for raw lines) and `reset`. Each
  `dump` call records the request context the generated server mounted for it.
- `host-test-raw` (hand-rolled stdio factory, `src/mcp/host-test-raw.ts`):
  `probe` records the raw SDK request context — session id, JSON-RPC id,
  `_meta`, lifted envelope, negotiated client info — so hook↔MCP correlation is
  judged against the wire.

The rendered CLI `host-test dump [--conversation <id>] [--full] [--log <file>]`
(`dist/bin/host-test.js`) reads the same log outside any host.

The log lives at `$HOST_TEST_LOG_DIR/captures.ndjson` when that variable is
set, otherwise `$AGENT_BUNDLE_PLUGIN_ROOT/state/host-test/captures.ndjson`
(the installed plugin root the host hands its MCP servers), otherwise beside
the artifact that ran the hook, otherwise `~/.host-test/`. `dump` always
prints the path it used.

## Scripted probing lifecycle

Everything runs in an isolated home under `/tmp/host-test/<host>-home`
(override with `HOST_TEST_ROOT`); the real `~/.claude`, `~/.codex`, and
`~/.cursor` are never opened or written.

```bash
pnpm --filter @agent-bundle-example/host-test build
pnpm --filter @agent-bundle-example/host-test probe:install claude    # or codex | cursor
pnpm --filter @agent-bundle-example/host-test probe:capture claude    # one scripted session
pnpm --filter @agent-bundle-example/host-test probe:status  claude
pnpm --filter @agent-bundle-example/host-test probe:uninstall claude
```

- `probe:install` builds when needed, creates the isolated home plus a scratch
  git workspace, copies the host's sign-in file byte-for-byte into the isolated
  home (`--no-auth` skips it; the copy is removed by `probe:uninstall`), and
  runs `agent-bundle install <host> --from artifact/<host>` with `HOME`,
  `CLAUDE_CONFIG_DIR`, or `CODEX_HOME` pointed at the isolated home. For Cursor
  it prints the isolated IDE launch line (`--user-data-dir`, `--extensions-dir`).
- `probe:capture` runs the scenario prompt through `claude -p`, `codex exec`, or
  `cursor-agent -p`: a shell command, a file edit, `dump`, `probe`, one subagent
  that repeats those and tries a nested subagent, then `HOST_TEST_DONE`. The
  session transcript and the records this run appended to `captures.ndjson`
  land in `/tmp/host-test/<host>/`, followed by a rendered `host-test dump`.
  Earlier runs' records are never re-copied, and the command exits non-zero
  when the host fails or when the run produced no hook record or no MCP record.
- Host processes get an allowlisted environment (PATH, locale, display, proxy,
  TLS plumbing) plus the isolated `HOME`; nothing else from your shell is
  inherited, and even allowlisted values are dropped when they carry a
  credential (proxy URLs with userinfo, bearer tokens). Hosts authenticate only
  from the copied sign-in files.
- `probe:uninstall` runs the host's own uninstall (`claude plugin uninstall`,
  `codex plugin remove`, or removing `~/.cursor/plugins/local/host-test`) and
  deletes the isolated home. Captures under `/tmp/host-test/<host>/` survive.

Cursor IDE sessions cannot be driven by `-p`; launch the isolated instance with
the printed command, open the Agents pane, and use the same scenario prompt.

## Workbench walkthrough

1. **Overview** lists the twenty event routes, both MCP servers, the skill, and
   the routed CLI with their per-target capability judgments — `workspace/open`
   is Cursor-only, `task/*` and `file/change` are Claude-only, and portable
   carries no hooks at all.
2. **Hooks** simulates any family with canonical input; the route appends a
   record to the log and returns an empty result (only `session/start` speaks
   an `additional_context` line naming the log path).
3. **Playground** runs `host-test dump` and the `dump` tool against the same
   log, so a simulated hook is visible from the MCP surface immediately.
4. **Lifecycles** replays checked-in native receipts and shows the request
   context — and lineage — each replay mounted.

## Noninteractive checks

```bash
cd examples/host-test
pnpm validate
pnpm build
pnpm typecheck
pnpm test
```

`pnpm check` runs the four in order.
