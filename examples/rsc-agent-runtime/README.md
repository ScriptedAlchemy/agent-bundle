# RSC Agent Runtime demo

This private, opt-in example shows one React Server Components (RSC) runtime shared by native file-edit hooks, MCP tools, and an MCP App timeline. It is an architecture experiment, not an `agent-bundle` public API.

## Four planes

| Plane | Responsibility | Lifetime |
| --- | --- | --- |
| Definition | Static hook matchers, tool schemas, resource URIs, and metadata | Build/startup |
| Kernel | Append-only JSONL events and snapshots | Cross-process |
| RSC render | Hook and MCP result component trees, lowered from Flight | One request |
| MCP App UI | Mounted timeline, Refresh, and recoverable row selection | One UI instance |

Native hooks are fresh requests: a process normalizes one host event, invokes the RSC worker, lowers the Flight result, and exits. The durable kernel—not a Node module cache or React state—connects later hook processes and MCP calls.

```tsx
// A Hook JSX route reads request-scoped context.
import { Hook } from '@agent-bundle/rsc-runtime';
import { useEdit, useRuntimeSnapshot } from '../runtime/request-context.js';

export function AfterFileEdit() {
  const edit = useEdit();
  const snapshot = useRuntimeSnapshot();
  return (
    <Hook.Result>
      <Hook.AdditionalContext>
        Recorded {edit.path}; {snapshot.edits.length} edits exist.
      </Hook.AdditionalContext>
    </Hook.Result>
  );
}
```

```tsx
// An MCP JSX route describes protocol blocks, not browser HTML.
import { Mcp } from '@agent-bundle/rsc-runtime';

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

The published Agent Bundle library is built with Rslib. This example's separate
production RSC/runtime artifacts are built by its explicit Rsbuild production
command (`pnpm --filter @agent-bundle/rsc-agent-runtime-demo build`); its provider
uses a separate long-lived Rsbuild development/HMR session only when an
`agent-bundle dev` project opts into `dev.runtime.provider`. Installing
`agent-bundle` alone does not install or activate this example provider. See
[the optional RSC Runtime topology](../../docs/architecture/rsc-runtime-workbench.md)
for the full ownership boundary.

The build emits `dist/runtime` (including `dist/runtime/agent-runtime.manifest.json`), self-contained `dist/app` MCP App documents, and two self-contained native plugin artifacts under `dist/plugins`. It runs `package:hosts` automatically; it can also be run directly:

```bash
pnpm --filter @agent-bundle/rsc-agent-runtime-demo package:hosts
```

To exercise one hook manually, give it an explicit state file and native Claude-shaped JSON:

```bash
AGENT_RUNTIME_STATE_FILE=/tmp/rsc-events.jsonl \
  node examples/rsc-agent-runtime/dist/runtime/hook/index.js --host claude <<JSON
{"hook_event_name":"PostToolUse","session_id":"manual","cwd":"$PWD","tool_name":"Write","tool_input":{"file_path":"README.md"}}
JSON
```

Run the built stdio MCP server with the same state file:

```bash
AGENT_RUNTIME_STATE_FILE=/tmp/rsc-events.jsonl \
  node examples/rsc-agent-runtime/dist/runtime/mcp/stdio.js
```

Run the Streamable HTTP server locally at `/mcp`:

```bash
AGENT_RUNTIME_STATE_FILE=/tmp/rsc-events.jsonl PORT=3000 \
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
through the built hook binary (RSC worker render, Flight lowering, durable
JSONL kernel write), then connects a real stdio MCP client to the built server
over the same state file and asserts the RSC-lowered `render_edit_timeline`
result, the shared edit snapshot, and the linked MCP App resource. It contacts
no real host and needs no credentials.

To exercise the Claude package manually when an external host run is separately
authorized, use its native shell contract:

```bash
claude -p "Create host-created.txt, then use recent_edits and render_edit_timeline." \
  --plugin-dir examples/rsc-agent-runtime/dist/plugins/claude \
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
AGENT_RUNTIME_STATE_FILE=/tmp/rsc-events.jsonl \
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

## Extension-author guide

The definition and lowerer keep serializable namespaced descriptor, resource, and result `_meta` opaque. Add a vendor extension as `_meta["vendor.example/feature"]`, merge it with `mergeSerializableMetadata`, and keep it out of model-visible text unless it belongs there. The optional Claude resource domain is added only to `resources/read` content metadata when an explicit public MCP URL is supplied; it is not added to resource registration by default.

Client adapters must feature-detect documented capabilities, validate recoverable presentation state, and synchronously persist only UI state. They must never make host state authoritative. Complete `content` and `structuredContent` remain available to text-only clients, and portable fallback behavior stays complete when a vendor capability is absent.

For ordinary MCP Apps, prefer Agent Bundle's standard non-RSC `mcp.servers.<server>.apps` compiler. It compiles self-contained HTML and exposes it through the virtual `agent-bundle/mcp-apps` resource lane without React/RSC runtime requirements. Opt into this paired RSC runtime only when hooks or MCP tool results genuinely need RSC Flight and shared runtime behavior.

## Limits and opt-in boundary

The demo kernel is append-only JSONL: it is appropriate for a small local example, not concurrent/distributed production storage. The RSC-facing packages are exact pins because their framework-facing surface is not treated as stable here: React `19.2.8`, `react-dom` `19.2.8`, `react-server-dom-rspack` `0.1.0`, Rsbuild `2.2.1`, and `rsbuild-plugin-rsc` `0.1.1`.

Existing Agent Bundle skills, static MCPs, evaluations, and normal hooks neither require nor activate this runtime. Nothing under `packages/agent-bundle` imports the example or React/RSC runtime packages.

`PlaygroundService` is the landed, provider-neutral durable whole-plugin
authoring timeline foundation. Runtime Playground history is deliberately
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
