# RSC Agent Runtime Demo Design

**Status:** Approved experiment

**Date:** 2026-08-14

## Summary

Build a self-contained example that proves an agent plugin can feel like one React application even
when lifecycle hooks are fresh operating-system processes. React Server Components provide the
author-facing render model and the Flight stream/RPC boundary. A file-backed runtime kernel, rather
than a JavaScript singleton, provides authoritative cross-process state.

The demo is deliberately outside `packages/agent-bundle`. It explores a possible future authoring
model without changing the compiler's public API or claiming the experiment is production-ready.
It is an opt-in supplement, not a replacement execution model: ordinary skills, static MCPs,
evaluations, and native hooks continue to work without React, RSC, this example, or any runtime
configuration.

The example is an edit timeline. Claude Code and Codex `PostToolUse` hooks record file edits. MCP
tools read the same state, can render protocol-native multimodal results through RSC, and expose a
React MCP App that visualizes the timeline and refreshes without remounting.

## Product thesis

The useful React analogy is request rendering, not a persistent browser reconciler:

1. A host starts the compiled hook command and sends native JSON over stdin.
2. The hook adapter normalizes that request and starts an RSC worker.
3. The worker performs the route action, reads or writes external state, and renders a Flight stream.
4. The adapter decodes the stream and lowers the React tree to the host's native hook JSON.
5. The process exits. The next hook invocation starts clean and reconstructs its view from the kernel.

There is no reliance on Node's module cache. React supplies composition, request context, streaming,
and a typed result tree; storage supplies continuity.

## Architecture

```text
Claude/Codex hook JSON
          |
          v
  host input adapter
          |
          v
  RSC worker process ---- action ----> file-backed runtime kernel
          |
       Flight stream
          |
          v
  Node Flight decoder
          |
          v
  host output adapter ---- stdout JSON ----> Claude/Codex

MCP Apps-capable host or text-only MCP client
          |
          v
  statically registered MCP server ---- read ----> same runtime kernel
          |                  |
          |                  +---- RSC result route ---- Flight ---- native MCP blocks
          |
          +---- ui:// resource ----> client React MCP App iframe
```

The system has four explicit planes:

| Plane | Responsibility | Discovery time | Lifetime |
| --- | --- | --- | --- |
| Definition | Hook matchers, MCP schemas, resource URIs, annotations | Build/startup | Static |
| Kernel | Durable edit events and snapshots | Per request/tool call | Cross-process |
| RSC render | Hook context and optional MCP result trees | Per invocation | Request-scoped |
| MCP App UI | Mounted timeline, refresh interaction, ephemeral selection | Resource load | UI instance |

## Author-facing API

Hook authors write ordinary server components and request hooks:

```tsx
import { Hook, useEdit, useRuntimeSnapshot } from '../runtime/rsc-api.js';

export function AfterFileEdit() {
  const edit = useEdit();
  const snapshot = useRuntimeSnapshot();

  return (
    <Hook.Result>
      <Hook.AdditionalContext>
        Recorded {edit.path} from {edit.host}. Shared state now contains{' '}
        {snapshot.edits.length} edits.
      </Hook.AdditionalContext>
    </Hook.Result>
  );
}
```

`useEdit()` and `useRuntimeSnapshot()` read an `AsyncLocalStorage` request context held open while
the Flight stream is consumed. They are intentionally not `useState`: a later invocation gets a new
render and a new snapshot.

MCP result components represent protocol values rather than HTML:

```tsx
return (
  <Mcp.Result structuredContent={timeline}>
    <Mcp.Text>{`Showing ${timeline.edits.length} edits.`}</Mcp.Text>
    <Mcp.Image data={STATUS_PNG_BASE64} mimeType="image/png" />
  </Mcp.Result>
);
```

The lowerer supports the complete result surface used by the current MCP schema:

- `Mcp.Text` -> text content block;
- `Mcp.Image` -> image content block;
- `Mcp.Audio` -> audio content block;
- `Mcp.ResourceLink` -> resource-link content block;
- `Mcp.EmbeddedResource` -> text or blob resource content block;
- `Mcp.Result` -> ordered `content`, optional `structuredContent`, and optional `isError`.

An `Mcp.Image` is never an HTML `<img>`. It becomes a base64 MCP `ImageContent` block. Browser
markup belongs to the separate widget bundle.

## Static definitions

MCP discovery never depends on rendering. `src/definition.ts` declares serializable descriptors and
separate handler IDs. At build time a Rsbuild plugin emits `dist/runtime/agent-runtime.manifest.json`, with
Zod schemas converted to JSON Schema. At server startup the complete registry is registered before
the transport connects and remains fixed for that server lifetime.

The demo exposes three tools:

1. `recent_edits`: read-only data tool returning a concise snapshot with no UI.
2. `render_edit_timeline`: read-only render tool accepting a prepared snapshot, returning it through
   an RSC result route, and linking the timeline UI resource.
3. `runtime_status`: read-only RSC result proving text, image, and structured content lowering.

Only `render_edit_timeline` has `_meta.ui.resourceUri`, mirrored to the optional ChatGPT
`_meta["openai/outputTemplate"]` compatibility alias. This preserves the decoupled data/render
pattern and avoids remounting the iframe on every refresh.

Static tool, resource, and result metadata remain open to serializable namespaced extensions. The
runtime preserves those values but does not make the portable core understand every vendor key.
This is how a plugin can opt into a host capability without forcing that capability, React, or RSC
onto unrelated Agent Bundle plugins.

The resource URI is versioned as `ui://rsc-agent-runtime/edit-timeline-v1.html`. Its MIME type is
`text/html;profile=mcp-app`. It declares an empty network/resource CSP because the build inlines its
JavaScript and CSS.

## Runtime kernel

The reference kernel is an append-only JSONL event store at
`<workspace>/.agent-runtime-demo/events.jsonl` or an explicit `AGENT_RUNTIME_STATE_FILE`.

```ts
interface EditEvent {
  eventId: string;
  host: 'claude' | 'codex';
  sessionId: string;
  toolName: string;
  path: string;
  recordedAt: string;
}

interface RuntimeSnapshot {
  stateVersion: number;
  edits: EditEvent[];
}
```

Each append is one newline-delimited write. A snapshot parses complete valid lines, ignores one
trailing partial line, and derives `stateVersion` from the number of valid events. This is a small
demo storage adapter, not a proposed distributed database. A production framework would preserve
the `RuntimeKernel` interface and offer SQLite, remote, or host-provided implementations.

Hook input supplies the workspace path. MCP tools resolve an explicit state-file environment value
first, then the first client root, then the server working directory. This lets the long-lived MCP
process and disposable hook processes converge on one authoritative file.

## RSC build and process boundary

Rsbuild 2.1 and `rsbuild-plugin-rsc` compile coordinated environments:

- `rsc`: the RSC plugin's Node server compiler, containing separate stable entries for the worker,
  hook adapter, and later the stdio/HTTP MCP consumers;
- `widget`: the RSC plugin's paired browser client compiler, containing matching inert anchors so
  Rspack can generate the consumer manifests needed by each Node Flight decoder;
- `app`: an ordinary, unpaired browser environment for the visible React MCP App.

The paired `rsc`/`widget` environments are protocol build machinery; the visible app never replaces
the paired anchors. The hook, worker, and MCP entries therefore remain separately executable while
sharing the exact Rspack-generated Flight manifest required by `client.node`.

Only `src/flight/request-render.ts` preserves runtime `import.meta.url`, through a matched
`module.rules[].parser = { importMeta: { url: false } }` override. Other modules retain Rspack's
normal `import.meta` processing. Node dynamic imports remain real split points: the `rsc`
environment emits one `dist/runtime` artifact root, places asynchronous JavaScript under
`dist/runtime/chunks`, and writes `runtime-assets.json` with each entry's initial and async assets.
Packaging copies that artifact root as a unit rather than guessing that named entry files are the
whole executable. The separate `app` environment uses Rsbuild's native
`output.inlineScripts` and `output.inlineStyles` options to emit `edit-timeline-v1.html` and
`standalone.html` as self-contained documents; no custom JavaScript/CSS concatenator is involved.

The RSC worker uses `renderToReadableStream` from
`react-server-dom-rspack/server.node`. Node consumers use `createFromReadableStream` from
`react-server-dom-rspack/client.node`. The worker writes only Flight bytes to stdout; diagnostics go
to stderr. This makes the stream boundary observable and prevents accidental JSON shortcuts.

## Native hook adapters

The source plugin contains two hook files because matcher and command details are host-native:

- Claude matches `Write|Edit` and reads `tool_input.file_path`.
- Codex matches `apply_patch|Write|Edit` and extracts the first patch path from
  `tool_input.command` when the canonical tool is `apply_patch`.

Both lower the decoded RSC result to `hookSpecificOutput.hookEventName = "PostToolUse"` and
`additionalContext`. The hook commands select the adapter with `--host claude` or `--host codex`.

## MCP and MCP Apps

One `createRuntimeMcpServer()` function registers tools and resources up front. It is connected by:

- `StdioServerTransport` for Claude Code and Codex;
- stateless `StreamableHTTPServerTransport` at `/mcp` for ChatGPT/MCP Apps inspection.

The timeline widget is an `interactive-decoupled` React widget adapted from the official OpenAI MCP
App Basics patterns. It uses `@modelcontextprotocol/ext-apps/react` to initialize the standard
MCP Apps JSON-RPC bridge, listens for tool results, and calls `recent_edits` from its Refresh button.
That wrapper maps to the standard `ui/initialize`, `ui/notifications/tool-result`, and `tools/call`
messages.

Agent Bundle's ordinary, non-RSC MCP App lane remains the default for simpler views:
`mcp.servers.<server>.apps` is normalized and validated, compiled to self-contained HTML, and
injected into its owning server through `agent-bundle/mcp-apps`. This example does not replace or
make that compiler depend on React Server Components. It adds an opt-in paired RSC build only for
advanced hook and tool-result rendering while keeping the same static `ui://` resource contract.

## Portability and host-specific extensions

Host support is progressive enhancement with four explicit extension lanes:

| Lane | Portable baseline | Demo-specific host behavior | Fallback |
| --- | --- | --- | --- |
| Tool descriptor | `_meta.ui.resourceUri` | ChatGPT `openai/outputTemplate` alias | Tool still returns text and structured content |
| UI resource | `_meta.ui` MIME/CSP/border metadata | ChatGPT description aliases; optional Claude stable app domain derived from a configured public MCP URL | No host-only metadata |
| Tool result | MCP `content`, `structuredContent`, and optional `_meta` | Serializable namespaced `_meta` passes through to the iframe without entering model-visible content | Model-visible result remains complete |
| Widget client | MCP Apps `ui/*` bridge and host context | Claude-provided style/safe-area context; feature-detected `window.openai.widgetState`/`setWidgetState` preserves selected-row UI state in ChatGPT | React instance state and documented fallback tokens |

The browser code tests for a capability, never a product name. The OpenAI adapter is a small optional
module: it reads a valid selected event ID from `window.openai.widgetState` and synchronously writes
the next selection with `setWidgetState`. It never stores authoritative edit data there. Without
that global, the same UI continues through the standard MCP Apps bridge.

Claude's current public interactive-connector contract is MCP Apps itself: `ui://` resources,
`text/html;profile=mcp-app`, sandboxed iframes, JSON-RPC, resource CSP, and host context. The public
MCP Apps guidance also documents Claude's stable-domain convention as the first 32 hex characters
of the public MCP URL's SHA-256 digest plus `.claudemcpcontent.com`. The demo exposes that domain
only when an explicit public URL is configured; it does not invent a Claude-only iframe global.
The widget uses the SDK's `useHostStyles` path and standard safe-area context, so Claude can supply
its light/dark palette, fonts, platform, and mobile insets while standalone and other hosts receive
the accepted concept tokens as CSS fallbacks.

Codex CLI is not the ChatGPT UI host. Its host-specific proof is the native Codex plugin manifest,
marketplace entry, MCP command, hook matcher/input adapter, and path-token behavior. Claude Code has
the corresponding Claude-native package and hook adapter. Both CLI artifacts exercise tools and
shared state; UI rendering is validated separately through the standards-based HTTP/browser path.

The widget also has a standalone development mode with deterministic sample data. Standalone state
is only a visual fallback; authoritative edit data always belongs to the kernel.

## Visual contract

The accepted reference is
`docs/assets/rsc-agent-runtime-demo/edit-timeline-concept.png`.

Design tokens extracted from it:

- canvas/surface: true white `#ffffff`;
- primary text: near-black navy `#10162a`;
- secondary text: cool gray `#667085`;
- borders/rail: `#d9dde7`;
- interaction/node accent: electric violet `#5b3df5`;
- mono family: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
- one outer 12px radius; rows are open, separated by 1px rules, not nested cards;
- desktop target: 760 x 500; mobile target: 360px wide without horizontal overflow.

These are the standalone/default fallback values. Inside an MCP Apps host, structural colors and
font families use standard host CSS variables with these values as fallbacks; violet remains the
demo's permitted brand accent. The host-context path must preserve the same hierarchy and anatomy
in both light and dark themes and apply `safeAreaInsets` without fixed host-name checks.

Visible copy is restricted to the concept strings and dynamic event values. The core interaction is
Refresh -> `tools/call recent_edits` -> update the mounted timeline and state version.

## Plugin packaging

Claude and Codex both reserve conventional root names such as `.mcp.json` and
`hooks/hooks.json`, but their path-token and manifest contracts differ. One physical plugin root
therefore cannot honestly carry both native configurations. The example keeps host templates apart
and materializes two self-contained build artifacts:

```text
examples/rsc-agent-runtime/
├── packaging/
│   ├── claude/{.claude-plugin,.mcp.json,hooks}/...
│   └── codex/{.agents,.codex-plugin,.mcp.json,hooks}/...
├── scripts/package-hosts.mjs
└── dist/plugins/
    ├── claude/{.claude-plugin,.mcp.json,hooks,runtime,app}/...
    └── codex/{.agents,.codex-plugin,.mcp.json,hooks,skills,runtime,app}/...
```

`runtime/` is an exact copy of the built Node artifact root, including `hook`, `rsc`, `mcp`,
`chunks`, `runtime-assets.json`, and the runtime definition manifest. `app/` contains the
self-contained MCP App documents. Claude launches the Node entries through `${CLAUDE_PLUGIN_ROOT}`.
Codex MCP uses a contained path relative to `cwd: "./"`, because native
Codex `.mcp.json` does not interpolate plugin/workspace placeholders; Codex hook commands use their
native `${PLUGIN_ROOT}` token. The Codex artifact also contains the full required interface metadata,
conventional `skills` path, and local marketplace manifest. Native evaluation always installs or
loads these materialized artifacts, never the ambiguous example source root.

## Verification and evaluation

Automated validation must prove:

- separate kernel instances observe the same append-only state;
- the hook command spawns the RSC worker, decodes real Flight, and returns valid native JSON;
- every MCP result element lowers to the correct protocol content block;
- stdio and Streamable HTTP clients see the same static tool/resource registry;
- the generated manifest contains JSON schemas and no executable functions;
- only the render tool links the UI resource;
- the resource serves the built widget with the MCP Apps MIME type and CSP metadata;
- the runtime manifest declares every initial and async JavaScript asset, and each copied native
  package can resolve and execute its dynamic chunks after the source build directory is absent;
- arbitrary serializable descriptor/resource/result metadata survives registration and lowering;
- an explicit public MCP URL produces the documented Claude stable app domain, while the default
  resource has no unnecessary host domain;
- a mocked ChatGPT capability restores and persists selected-row UI state, while the same widget
  works with no `window.openai` global;
- Claude-compatible standard host context applies host style variables, dark theme, and safe-area
  insets without changing the MCP Apps bridge or requiring a Claude vendor global;
- the standalone widget renders at desktop and mobile widths and Refresh updates its state;
- Claude Code 2.1.232 and Codex CLI 0.147.0 each perform a real edit, trigger the native hook, and
  read that event through the demo MCP server using their already-configured sessions.

The ChatGPT remote Developer Mode loop is documented but not claimed unless a public HTTPS endpoint
is actually connected. Local HTTP MCP, resource, bridge, browser, Claude, and Codex evidence are
separate claims.

## Boundaries

- This is an example and architecture probe, not a new `agent-bundle` public API.
- Agent Bundle's standard `mcp.servers.*.apps` compiler remains the non-RSC path for ordinary MCP
  Apps; the example documents when the supplemental paired runtime is warranted.
- The runtime is activated only by building/running the private example. `packages/agent-bundle`
  must not import the example or acquire React/RSC runtime, peer, or optional dependencies.
- Existing non-RSC skills, MCP servers, evaluations, and plain hook flows remain the compatibility
  baseline and must pass the root package checks unchanged.
- RSC package versions are exact pins because framework-facing RSC APIs are not semver-stable.
- The demo does not dynamically register tools or resources.
- It does not pretend hook processes retain React state or module caches.
- It does not use provider API keys; native CLI evaluations inherit existing subscription/session
  authentication.
- It does not claim the CLI hosts render the MCP App iframe. They validate the shared tools and
  hooks; the HTTP/browser path validates the UI surface.
- It does not branch on host names in widget code or fabricate a proprietary Claude browser API.

## Source baselines

- Rsbuild RSC support and `rsbuild-plugin-rsc` 0.1.1.
- React 19.2.8 and `react-server-dom-rspack` 0.0.3.
- MCP TypeScript SDK 1.30.0, `@modelcontextprotocol/ext-apps` 1.7.5, Zod 4.4.3, and Express 5.2.1.
- OpenAI Apps SDK examples commit `18cc38e78a968712c357bacdc3c79fead5bfc6b4`, specifically the
  MCP App Basics server and React `useApp` result/tool-call patterns.
- OpenAI plugin UI guidance at `https://developers.openai.com/plugins/build/chatgpt-ui`, including
  the standards-first MCP Apps path and optional feature-detected widget-state extension.
- MCP Apps patterns at `https://apps.extensions.modelcontextprotocol.io/api/documents/Patterns.html`,
  including host context, resource metadata placement, and the Claude stable-domain convention.
- Claude cross-platform MCP Apps guidance at
  `https://claude.com/docs/connectors/building/mcp-apps/cross-compatibility` and design guidance at
  `https://claude.com/docs/connectors/building/mcp-apps/design-guidelines`.
- Claude interactive-connector guidance at
  `https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude`.
- Claude Code 2.1.232 and Codex CLI 0.147.0 native contracts.
