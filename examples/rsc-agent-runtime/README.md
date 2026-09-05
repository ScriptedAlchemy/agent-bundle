# RSC Agent Runtime demo

This private, opt-in example shows one React Server Components (RSC) runtime shared by native file-edit hooks, MCP tools, and an MCP App timeline. It is an architecture experiment, not an `agent-bundle` public API.

## Four planes

| Plane | Responsibility | Lifetime |
| --- | --- | --- |
| Definition | Static hook matchers, tool schemas, resource URIs, and metadata | Build/startup |
| Kernel | Framework state kernel (#98): typed events, monotonic revisions, workspace-durable `node:sqlite` storage | Cross-process |
| RSC render | Hook and MCP result component trees, lowered from Flight | One request |
| MCP App UI | Mounted timeline, Refresh, and recoverable row selection | One UI instance |

Native hooks are fresh requests: the compiler-generated client validates one host event, invokes `src/events/tool/after.tsx` in its explicit standalone mode, projects the final Agent Document, and exits. The durable kernel—not a Node module cache or React state—connects later hook processes and MCP calls.

```tsx
// The semantic event route receives canonical identity — including the family's
// cross-host `payload` — plus the complete native envelope for host-specific fields.
import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';

export const config = { runtime: 'standalone', targets: ['claude', 'codex'] };

export default async function AfterFileEdit({ canonical }: AgentEventRouteProps<'tool/after'>) {
  const toolName = canonical.payload.toolName?.value ?? 'an unnamed tool';
  return (
    <Agent.Result>
      <Agent.Context>{`Recorded ${toolName} from ${canonical.provenance.host}.`}</Agent.Context>
    </Agent.Result>
  );
}
```

```tsx
// An MCP JSX route describes protocol blocks, not browser HTML.
import { Mcp } from '@agent-bundle/runtime';

export function RenderTimeline({ snapshot }: { snapshot: { edits: unknown[]; stateVersion: number } }) {
  return (
    <Mcp.Result structuredContent={snapshot}>
      <Mcp.Text>{`Showing ${snapshot.edits.length} edits.`}</Mcp.Text>
    </Mcp.Result>
  );
}
```

## Run locally

From the repository root:

```bash
pnpm --filter @agent-bundle/rsc-agent-runtime-demo build
pnpm --filter @agent-bundle/rsc-agent-runtime-demo test
pnpm --filter @agent-bundle/rsc-agent-runtime-demo typecheck
pnpm --filter @agent-bundle/rsc-agent-runtime-demo capture:widget -- --output /tmp/rsc-agent-runtime-widget.png
pnpm docs:runtime-topology
```

For contributor Workbench/HMR evidence, use the repository fixture rather than
the published package:

```bash
node packages/workbench/scripts/capture-runtime-playground.mjs \
  --desktop "$PWD/docs/assets/rsc-runtime-workbench/desktop.png" \
  --hmr-before "$PWD/docs/assets/rsc-runtime-workbench/hmr-before.png" \
  --hmr-after "$PWD/docs/assets/rsc-runtime-workbench/hmr-after.png" \
  --compile-error "$PWD/docs/assets/rsc-runtime-workbench/compile-error.png" \
  --recovered "$PWD/docs/assets/rsc-runtime-workbench/recovered.png" \
  --evidence /tmp/rsc-runtime-delivery/evidence.json
```

The `--compile-error` capture shows the Workbench diagnostic the provider
publishes when a source change fails to compile: code `AB8206`, phase
`source/build`, and a message that carries the Rspack errors themselves — one
`file:line:col: message` line per error, with the path relative to the example
root, ANSI colour and the SWC code frame stripped. Breaking `src/rsc/worker.tsx`
produces, for example:

```text
RSC runtime source build failed: RSC runtime compile reported 1 error(s):
src/rsc/worker.tsx:177:6: Module build failed (from builtin:swc-loader): Syntax Error: Unexpected token `=`. Expected yield, an identifier, [ or {
```

The active generation stays served while the diagnostic is shown, and the next
successful compile clears it. The development session runs Rsbuild at
`logLevel: 'silent'`, so the diagnostic — not the provider's console — is the
one place the message lands; the errors are read with the `agent-bundle/api`
helpers (`rspackStatsErrors`, `formatRspackStatsError`) the framework's own
`AB4770` App diagnostics use. The production `rsbuild build` has no diagnostic
channel, so it keeps `logLevel: 'error'` and prints the same errors to the
console before rejecting.

The published Agent Bundle library is built with Rslib. This example's separate
production RSC/runtime artifacts are built by its explicit Rsbuild production
command (`pnpm --filter @agent-bundle/rsc-agent-runtime-demo build`); its provider
uses a separate long-lived Rsbuild development/HMR session only when an
`agent-bundle dev` project opts into `dev.runtime.provider`. That session
compiles with Rsbuild `mode: 'development'` (development React and
react-server-dom, readable identifiers). `rsbuild build --mode production`
stays production so Flight payloads and the packaged App HTML stay the
compact surface hosts load. `@rsbuild/plugin-react` is configured as
`pluginReact({ fastRefresh: false })`: the compiler App is an opaque srcdoc
child with `hmr: false`, and the runtime-surface outer document owns the one
HMR socket. The `widget` and `app` web environments set
`overrideBrowserslist: ['chrome >= 144']` for the Chromium MCP App hosts
(Cursor 3.18.25 still ships Chromium 144; Claude Desktop Electron 42 and
Cursor 3.19.7 ship Chromium 148; ChatGPT/Codex Desktop reports Chromium 151).
The Node `rsc` environment does not inherit that browserslist. The stdio MCP
entry stays self-built inside those Rsbuild artifacts but consumes the
framework's stdio lifecycle (console-to-stderr guard, SIGINT/SIGTERM exit
codes, stdin-EOF shutdown) through the public `agent-bundle/mcp-entry` API.
Host packaging is framework-owned: `agent-bundle.config.ts` declares the
Rsbuild output trees as prebuilt `payload` directories with prebuilt MCP and
hook entries, and `agent-bundle build` copies them byte-for-byte at their
stable paths while generating every host manifest.
Installing
`agent-bundle` alone does not install or activate this example provider. See
[the optional RSC Runtime topology](../../docs/architecture/rsc-runtime-workbench.md)
for the full ownership boundary.

The build emits `dist/runtime` (including `dist/runtime/agent-runtime.manifest.json`), self-contained `dist/app` MCP App documents, and one self-contained composite plugin root at `dist/plugins` (the portable, Claude Code, and Codex projections over the shared payload). `dist/app` holds exactly one HTML file per App entry (`edit-timeline-v1.html`, `standalone.html`) with every script, style, asset, and licence comment inlined — the same invariants the framework's MCP App compiler enforces (`splitChunks: false`, unbounded `dataUriLimit`, no async chunks, `legalComments: 'inline'`); the build fails if the resolved configuration drifts from them or any sibling file would be emitted. The packaging step can also be rerun directly against the current Rsbuild output:

```bash
pnpm --filter @agent-bundle/rsc-agent-runtime-demo exec agent-bundle build --json --output dist/plugins
```

To exercise one hook manually, give it an explicit state file and native Claude-shaped JSON:

```bash
AGENT_RUNTIME_STATE_FILE=/tmp/rsc-agent-state.sqlite \
  node examples/rsc-agent-runtime/dist/plugins/hooks/event-route-tool-after.claude.mjs <<JSON
{"hook_event_name":"PostToolUse","session_id":"manual","cwd":"$PWD","transcript_path":"$PWD/transcript.jsonl","tool_name":"Write","tool_input":{"file_path":"README.md"},"tool_response":{"success":true},"tool_use_id":"manual-write-1"}
JSON
```

Run the built stdio MCP server with the same state file:

```bash
AGENT_RUNTIME_STATE_FILE=/tmp/rsc-agent-state.sqlite \
  node examples/rsc-agent-runtime/dist/runtime/mcp/stdio.js
```

Run the Streamable HTTP server locally at `/mcp`:

```bash
AGENT_RUNTIME_STATE_FILE=/tmp/rsc-agent-state.sqlite PORT=3000 \
  node examples/rsc-agent-runtime/dist/runtime/mcp/http.js
```

| Static surface | Result |
| --- | --- |
| `recent_edits` | Text plus `structuredContent` snapshot |
| `render_edit_timeline` | RSC-lowered text and snapshot; links the versioned timeline resource |
| `runtime_status` | RSC-lowered text, image, and structured status |
| `ui://rsc-agent-runtime/edit-timeline-v1.html` | `text/html;profile=mcp-app` self-contained React timeline |

`Mcp.Text`, `Mcp.Image`, `Mcp.Audio`, `Mcp.ResourceLink`, and `Mcp.EmbeddedResource` lower to their matching MCP content blocks. `Mcp.Result` supplies ordered `content`, optional `structuredContent`, optional `isError`, and optional serializable `_meta`.

## Native packages and evaluation

Claude Code has a native compact manifest, `${CLAUDE_PLUGIN_ROOT}` paths, and a
`Write|Edit` `PostToolUse` hook contract. Codex has a separate native manifest,
marketplace entry, `cwd: "./"` MCP path, and `apply_patch` hook contract.

**Native evaluation policy:** Real Claude Code and Codex CLI runs are
intentionally skip-gated out of ordinary CI and default test runs. They are
explicit opt-ins: the manually dispatched trusted `Native host smoke` workflow
or a local `eval:hosts` run after normal interactive sign-in. Ordinary CI
instead proves this runtime path with the deterministic micro-eval spot-check
below plus the evaluator, packaging, and browser contracts. No attached tracked
schema-v2 native-evidence artifact exists in this repository snapshot, so this
README makes no successful native-host observation claim.

### CI micro-eval spot-check

Ordinary CI runs a deterministic micro-eval against the built production
artifacts on every push and pull request:

```bash
pnpm eval:spot
```

It builds this example, replays one native-shaped Claude `PostToolUse` event
through the compiled `src/events/tool/after.tsx` route (Agent Document projection, a durable
state-kernel commit), replays the same native tool id from a second hook
process to prove cross-process idempotency, then connects a real stdio MCP
client to the built server over the same state file and asserts the
RSC-lowered `render_edit_timeline` result, the shared edit snapshot, and the
linked MCP App resource. It contacts no real host and needs no credentials.

To exercise the Claude package manually when an external host run is separately
authorized, use its native shell contract:

```bash
claude -p "Create host-created.txt, then use recent_edits and render_edit_timeline." \
  --plugin-dir examples/rsc-agent-runtime/dist/plugins \
  --output-format stream-json --verbose --include-hook-events \
  --no-session-persistence --dangerously-skip-permissions
```

To capture real-run evidence in a separately authorized, signed-in
environment, first make the package artifacts, then run each selected terminal
host explicitly:

```bash
pnpm --filter @agent-bundle/rsc-agent-runtime-demo build
pnpm --filter @agent-bundle/rsc-agent-runtime-demo eval:hosts -- --host claude
pnpm --filter @agent-bundle/rsc-agent-runtime-demo eval:hosts -- --host codex
```

The evaluator requires exactly Claude Code `2.1.232` and Codex CLI `0.147.0`, creates a temporary Git workspace, and emits one sanitized schema-v2 JSON evidence document. Attach that stdout document as tracked evidence before
stating a native observation. Each native envelope contains only its
host/version and six claim-level observations: package activation, hook
dispatch, MCP read, RSC render, shared hook/MCP state, and MCP App iframe
support. Hook proof comes from the value-free hook launch probe; MCP tool proof
requires one exact non-error native `tool_result` correlated to its matching
tool use. Native CLI children receive only an ordinary-session environment
allowlist plus owned temporary paths; the evaluator never forwards provider
credential, token, routing, module-path, or caught-error text, stores raw
transcripts, or prints authentication content. Any unavailable or incomplete
selected native run exits nonzero while still emitting its complete truthful
evidence envelope.

The terminal boundary is unchanged: MCP App iframe evidence is unavailable from either terminal CLI. Codex CLI is not the ChatGPT UI host, and native
PostToolUse/shared state remains unproven under pinned `codex exec --ephemeral`.
The packaged matcher accepts `apply_patch` command-shaped hook payloads in
deterministic contract tests, but that parser compatibility does not certify
native hook dispatch; [the upstream Codex issue is analogous
evidence](https://github.com/openai/codex/issues/26729), not proof of the exact
cause.

Portable, ChatGPT/OpenAI, and Claude Workbench profiles are local compatibility simulations, and deterministic evaluator tests are not native certification.
ChatGPT Developer Mode is not claimed in this evidence matrix unless a user
separately captures a real public HTTPS-host result.

## ChatGPT Developer Mode and local browser evidence

The widget is locally tested over its MCP Apps resource/HTTP/browser path. To connect it to ChatGPT Developer Mode, expose local `/mcp` through a public HTTPS tunnel and allow that exact public host/origin before starting the server:

```bash
AGENT_RUNTIME_STATE_FILE=/tmp/rsc-agent-state.sqlite \
AGENT_RUNTIME_ALLOWED_HOSTS=tunnel.example \
AGENT_RUNTIME_ALLOWED_ORIGINS=https://tunnel.example \
AGENT_RUNTIME_PUBLIC_MCP_URL=https://tunnel.example/mcp \
PORT=3000 node examples/rsc-agent-runtime/dist/runtime/mcp/http.js
```

In ChatGPT Developer Mode, add the public HTTPS MCP URL, authorize the connection as prompted, and refresh/reconnect after descriptor changes so the host discovers the static tool/resource registry again. This repository validates local Streamable HTTP, resource delivery, the standard MCP Apps bridge, and browser behavior; it does **not** claim a live ChatGPT Developer Mode connection unless you perform and separately capture that external HTTPS-host result.

Host/Origin allowlists mitigate DNS rebinding and cross-origin requests, but they do **not** authenticate a public tunnel. Production exposure still needs the deployment's authentication and authorization layer.

## Capability matrix

| Host/lane | Supported behavior | Fallback/boundary |
| --- | --- | --- |
| Portable MCP Apps simulation | `ui://` resource, MCP Apps bridge, Refresh through `tools/call`, local selected row | Local simulation only; no vendor browser global or host domain required |
| ChatGPT/OpenAI simulation | `openai/outputTemplate` descriptor alias and feature-detected `window.openai.widgetState` / `setWidgetState` | Local simulation only; selection stays React-instance-local without both documented capabilities |
| Claude MCP Apps simulation | Standard bridge, `useHostStyles`, standard dark/light variables, font CSS, safe-area insets, optional deterministic resource domain | Local simulation only; no `window.claude`, user-agent, or product-name branch |
| Claude Code | Native package contract: `${CLAUDE_PLUGIN_ROOT}` MCP/hook paths and `Write|Edit` hook | Real host run is a skip-gated manual opt-in; no attached native evidence in this snapshot; never an iframe renderer |
| Codex CLI | Native package contract: marketplace, relative MCP path, `${PLUGIN_ROOT}` hook, and `apply_patch` matcher | Real host run is a skip-gated manual opt-in; no attached native evidence in this snapshot; native PostToolUse/shared state remains unproven under `exec --ephemeral` |

### Semantic event-route support

| Event family | Cursor | Claude Code 2.1.260 | Codex 0.147.0 |
| --- | --- | --- | --- |
| `session/start` | Supported | `SessionStart` | `SessionStart` |
| `session/end` | `sessionEnd` (observe-only; desktop only) | `SessionEnd` (observe-only) | `SessionEnd` (observe-only) |
| `prompt/submit` | `beforeSubmitPrompt` (deny) | `UserPromptSubmit` (deny + context) | `UserPromptSubmit` (deny + context) |
| `tool/before` | Supported | `PreToolUse` | `PreToolUse` |
| `tool/after` | Supported | `PostToolUse` | `PostToolUse` |
| `tool/failure` | `postToolUseFailure` (observe-only) | `PostToolUseFailure` (context) | Unavailable |
| `compact/before` | `preCompact` (observe-only; native `user_message` not modeled) | `PreCompact` (deny) | `PreCompact` (observe-only) |
| `compact/after` | Unavailable | `PostCompact` (observe-only) | `PostCompact` (observe-only; no summary field) |
| `permission/request` | Unavailable | `PermissionRequest` (allow/deny) | `PermissionRequest` (allow/deny) |
| `permission/denied` | Unavailable | `PermissionDenied` (observe-only) | Unavailable |
| `stop` | Supported | `Stop` | `Stop` |
| `stop/failure` | Unavailable | `StopFailure` (observe-only) | Unavailable |
| `file/change` | Unavailable (agent-edit `afterFileEdit` stays a `tool/after` variant) | `FileChanged` (observe-only) | Unavailable |
| `config/change` | Unavailable | `ConfigChange` (deny) | Unavailable |
| `task/create` | Unavailable | `TaskCreated` (deny) | Unavailable |
| `task/complete` | Unavailable | `TaskCompleted` (observe-only; blocking is exit-code-only) | Unavailable |
| `agent/idle` | Unavailable | `TeammateIdle` (deny via continue:false) | Unavailable |
| `model-switch/before` | Unavailable | `PreModelSwitch` (allow/ask/deny; 2.1.251+) | Unavailable |
| `model-switch/after` | Unavailable | `PostModelSwitch` (observe-only + context; 2.1.251+) | Unavailable |
| `agent/start` | `subagentStart` (deny via `permission: "deny"`; no context channel) | `SubagentStart` (context) | `SubagentStart` (context) |
| `agent/stop` | `subagentStop` (deny via `followup_message`; no context channel) | `SubagentStop` (deny + context) | `SubagentStop` (deny) |
| `workspace/open` | Supported (observe-only; native `pluginPaths` return not modeled) | Unavailable | Unavailable |

Cursor's native `workspaceOpen` is sessionless and its optional `pluginPaths`
return is deliberately not modeled. Event routes observe the documented
workspace envelope and emit no native output; plain `hooks.events.workspaceOpen`
handlers remain unavailable because their session-scoped vocabulary cannot
express it.
`agent/start` is context-injection-only on Claude Code and Codex and cannot
block subagent creation. Their `agent/stop` routes can continue the subagent
with the native `decision: "block"` plus `reason` contract. Codex
`SubagentStop` exit-0 output is always JSON; its generated 0.147.0 output
schema has no `additionalContext` field, so the route projection rejects that
unsupported effect rather than silently fabricating one. Cursor inverts the
pair: its `subagentStart` envelope (`subagent_id`, `subagent_type`, `task`,
`parent_conversation_id`, `tool_call_id`, `subagent_model`,
`is_parallel_worker`) accepts `permission: "deny"` plus `user_message`, and its
`subagentStop` envelope (`status`, `loop_count`, `summary`, `modified_files`,
`agent_transcript_path`) accepts only `followup_message`, which Cursor consumes
when `status` is `completed` and caps with `loop_limit` (default 5). Neither
Cursor event documents an additional-context channel, so `Agent.Context` fails
closed on Cursor for both.
`session/end` and `prompt/submit` are event-route-only families and do not add
`config.hooks.sessionEnd` or `config.hooks.promptSubmit` handler keys.
`session/end` rejects every result effect because each native event is
observe-only. `prompt/submit` maps canonical deny to each host's blocking
contract; Claude Code and Codex also accept `Agent.Context`, while Cursor has
no context or prompt-rewrite channel. Cursor cloud agents do not expose
`sessionEnd`.
`tool/failure`, `compact/before`, and `compact/after` are also event-route-only
families. Claude Code alone maps `tool/failure` context and
`compact/before` deny; every other result effect fails closed. Cursor's
`preCompact.user_message` is user-facing rather than agent context, and the
Codex compact schemas do not pin event-level semantics for their common output
fields, so neither channel is projected. Codex has no tool-failure event,
Cursor has no post-compaction event, and Codex `PostCompact` carries no summary.

## Extension-author guide

The definition and lowerer keep serializable namespaced descriptor, resource, and result `_meta` opaque. Add a vendor extension as `_meta["vendor.example/feature"]`, merge it with `mergeSerializableMetadata`, and keep it out of model-visible text unless it belongs there. The optional Claude resource domain is added only to `resources/read` content metadata when an explicit public MCP URL is supplied; it is not added to resource registration by default.

Client adapters must feature-detect documented capabilities, validate recoverable presentation state, and synchronously persist only UI state. They must never make host state authoritative. Complete `content` and `structuredContent` remain available to text-only clients, and portable fallback behavior stays complete when a vendor capability is absent.

For ordinary MCP Apps, prefer Agent Bundle's standard non-RSC `mcp.servers.<server>.apps` compiler. It compiles self-contained HTML and exposes it through the virtual `agent-bundle/mcp-apps` resource lane without React/RSC runtime requirements. Opt into this paired RSC runtime only when hooks or MCP tool results genuinely need RSC Flight and shared runtime behavior.

## Limits and opt-in boundary

Durable state rides the framework state kernel's workspace-durable driver
(`@agent-bundle/runtime/state/sqlite`, issue #98): one SQLite database per
workspace on Node's built-in `node:sqlite`, with WAL journaling, transactional
commits, idempotency-key replay, and exact-revision reads. The retired
hand-rolled JSONL kernel is gone; this example now only declares its schema,
events, and reducer. Loading the sqlite driver emits Node's one-time
`ExperimentalWarning: SQLite is an experimental feature` on stderr — expected
on the supported Node lines (`node:sqlite` needs no flag on Node >= 22.13),
harmless for hooks and MCP servers (protocol output uses stdout), and absent
for stateless consumers because the driver lives behind its own subpath. It is
suitable local single-workspace storage, not concurrent/distributed production
storage. The RSC-facing packages are exact pins because their framework-facing
surface is not treated as stable here: React `19.2.8`, `react-dom` `19.2.8`,
`react-server-dom-rspack` `0.1.0`, Rsbuild `2.2.3`, and `rsbuild-plugin-rsc`
`0.1.1`.

Existing Agent Bundle skills, static MCPs, evaluations, and normal hooks neither require nor activate this runtime. Nothing under `packages/agent-bundle` imports the example or React/RSC runtime packages.

`PlaygroundService` is the landed, provider-neutral durable whole-plugin
authoring timeline foundation. Runtime history now backs the selected
Application route workspace rather than a separate destination. It remains
provider-session-scoped and ephemeral in this example; wiring a provider
adapter, authenticated API, timeline UI, durable Runtime export, or evaluation
promotion onto that history is an explicit non-goal of this demo.

## Sources

- [Rsbuild React Server Components plugin](https://www.npmjs.com/package/rsbuild-plugin-rsc)
- [MCP Apps patterns and host context](https://apps.extensions.modelcontextprotocol.io/api/documents/Patterns.html)
- [OpenAI plugin UI / ChatGPT MCP Apps guidance](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Claude MCP Apps cross-compatibility](https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility) and [design guidance](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex CLI documentation](https://developers.openai.com/codex/cli)
- [Codex 0.147.0 `apply_patch` PostToolUse payload](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/src/tools/handlers/apply_patch.rs#L2237-L2264) and [analogous hook issue #26729](https://github.com/openai/codex/issues/26729)
