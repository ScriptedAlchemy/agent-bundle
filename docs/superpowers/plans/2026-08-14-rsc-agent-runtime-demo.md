# RSC Agent Runtime Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable, strictly opt-in dual-host plugin example in which Claude Code and Codex lifecycle hooks render through a real Rsbuild RSC Flight boundary, share external state with a static MCP server, and expose that state through a React MCP App, without changing how ordinary Agent Bundle skills, MCPs, evaluations, or plain hooks work.

**Architecture:** Disposable hook commands normalize native input, ask a Node RSC worker to mutate/read a file-backed kernel and render a Flight stream, decode that stream, and lower its React result tree to native host JSON. A separately registered MCP server reads the same kernel, optionally renders protocol-native MCP results through the same RSC worker, and serves a statically built client React timeline over the MCP Apps resource contract. Serializable metadata and feature-detected client adapters provide optional host-specific lanes around that portable core.

**Tech Stack:** Node.js 22.19+, TypeScript 7.0.2 ESM, Rsbuild 2.1.13, `rsbuild-plugin-rsc` 0.1.1, React/React DOM 19.2.8, `react-server-dom-rspack` 0.0.3, MCP TypeScript SDK 1.30.0, MCP Ext Apps 1.7.5, Zod 4.4.3, Express 5.2.1, Rstest 0.11.8, Playwright Core 1.62.1 with installed Chrome.

## Global Constraints

- Keep the experiment under `examples/rsc-agent-runtime`; do not change the `agent-bundle` public API or compiler behavior.
- Keep the runtime supplemental and explicitly opt-in. No source under `packages/agent-bundle` may
  import the example or require React/RSC packages or runtime configuration for existing skills,
  static MCPs, evaluations, or normal hook builds.
- Pin `react`, `react-dom`, `react-server-dom-rspack`, and `rsbuild-plugin-rsc` to exact versions.
- Register every MCP tool and resource before connecting a transport; rendering must never discover or add tools.
- Use `renderToReadableStream` from `react-server-dom-rspack/server.node` and `createFromReadableStream` from `react-server-dom-rspack/client.node`; do not substitute JSON for the Flight boundary.
- Treat the file-backed kernel as authoritative; do not rely on module cache, process globals, or React client state for cross-process data.
- Write only native hook JSON to the hook command's stdout and only Flight bytes to the RSC worker's stdout; send diagnostics to stderr.
- Preserve Node dynamic imports and package their real outputs. The `rsc` environment must emit one
  `dist/runtime` artifact root with an explicit `jsAsync` chunk lane and `runtime-assets.json`;
  native packaging must copy and verify every declared asset rather than forcing eager imports or
  selecting only named entry directories.
- Support MCP text, image, audio, resource-link, embedded-resource, `structuredContent`, and `isError` lowering.
- Link only `render_edit_timeline` to `ui://rsc-agent-runtime/edit-timeline-v1.html`, using
  `_meta.ui.resourceUri` as the primary field and `_meta["openai/outputTemplate"]` as the ChatGPT
  compatibility alias.
- Build the widget on the MCP Apps bridge. Add one real, optional ChatGPT enhancement by
  feature-detecting `window.openai.widgetState`/`setWidgetState` for selected-row UI state; the
  standards-only path must behave fully without it, and authoritative edit data must remain in the
  kernel.
- Preserve arbitrary serializable namespaced `_meta` at static descriptor/resource and tool-result
  boundaries. Support the documented Claude stable app-domain convention only when a public MCP URL
  is explicitly configured. Do not branch on product names in the widget or invent a Claude-only
  browser API.
- Use the standard MCP Apps host context and `useHostStyles` helper for host-provided light/dark
  variables and fonts, and apply `safeAreaInsets`. Keep the accepted concept palette as CSS
  fallbacks so standalone and hosts without style values remain complete.
- Use the installed Claude Code 2.1.232 and Codex CLI 0.147.0 sessions for native evaluations; never accept, request, inject, inspect, or persist an API key.
- Preserve the accepted visual contract at `docs/assets/rsc-agent-runtime-demo/edit-timeline-concept.png` and verify desktop and 360px-wide renderings before completion.

---

## File Structure

```text
examples/rsc-agent-runtime/
├── package.json
├── rsbuild.config.ts
├── rstest.config.ts
├── tsconfig.json
├── packaging/
│   ├── claude/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── .mcp.json
│   │   └── hooks/hooks.json
│   └── codex/
│       ├── .agents/plugins/marketplace.json
│       ├── .codex-plugin/plugin.json
│       ├── .mcp.json
│       └── hooks/hooks.json
├── src/
│   ├── definition.ts
│   ├── runtime/
│   │   ├── contracts.ts
│   │   ├── state-file.ts
│   │   ├── request-context.ts
│   │   ├── elements.tsx
│   │   ├── lower-hook.ts
│   │   └── lower-mcp.ts
│   ├── rsc/
│   │   ├── components.tsx
│   │   ├── routes.tsx
│   │   ├── worker.tsx
│   │   └── client-anchor.ts
│   ├── types/
│   │   └── react-server-dom-rspack.d.ts
│   ├── hook/
│   │   ├── normalize.ts
│   │   └── cli.ts
│   ├── flight/
│   │   └── request-render.ts
│   ├── mcp/
│   │   ├── create-server.ts
│   │   ├── handlers.ts
│   │   ├── host-metadata.ts
│   │   ├── resolve-state.ts
│   │   ├── stdio.ts
│   │   └── http.ts
│   ├── widget/
│   │   ├── App.tsx
│   │   ├── host-adapters.ts
│   │   ├── index.tsx
│   │   └── styles.css
│   └── build/
│       ├── serialize-definition.ts
│       └── emit-artifacts.ts
├── scripts/
│   ├── package-hosts.mjs
│   ├── eval-hosts.mjs
│   └── capture-widget.mjs
├── tests/
│   ├── state-and-definition.test.ts
│   ├── rsc-hook.integration.test.ts
│   ├── mcp-lowering.test.tsx
│   ├── mcp-transports.integration.test.ts
│   ├── host-extensions.test.tsx
│   └── host-artifacts.test.ts
└── README.md
```

### Task 1: Static definition and cross-process runtime kernel

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `examples/rsc-agent-runtime/package.json`
- Create: `examples/rsc-agent-runtime/tsconfig.json`
- Create: `examples/rsc-agent-runtime/rstest.config.ts`
- Create: `examples/rsc-agent-runtime/src/runtime/contracts.ts`
- Create: `examples/rsc-agent-runtime/src/runtime/state-file.ts`
- Create: `examples/rsc-agent-runtime/src/definition.ts`
- Create: `examples/rsc-agent-runtime/src/build/serialize-definition.ts`
- Test: `examples/rsc-agent-runtime/tests/state-and-definition.test.ts`

**Interfaces:**
- Produces: `createFileRuntimeKernel(options: { stateFile: string; now?: () => Date; createId?: () => string }): RuntimeKernel`
- Produces: `RuntimeKernel.recordEdit(input: Omit<EditEvent, 'eventId' | 'recordedAt'>): Promise<RuntimeSnapshot>`
- Produces: `RuntimeKernel.readSnapshot(options?: { limit?: number }): Promise<RuntimeSnapshot>`
- Produces: `runtimeDefinition: RuntimeDefinition`
- Produces: `serializeRuntimeDefinition(definition?: RuntimeDefinition): SerializedRuntimeDefinition`
- Consumes later: exact `EditEvent`, `RuntimeSnapshot`, `CanonicalPostToolUse`, `RenderRequest`, and `McpTimeline` types from `contracts.ts`.

- [ ] **Step 1: Add the example workspace and exact dependencies**

  Add `examples/*` to root `workspaces`. Create the example package named
  `@agent-bundle/rsc-agent-runtime-demo` with `private: true`, `type: module`, and scripts:

  ```json
  {
    "build": "rsbuild build",
    "test": "rstest --config rstest.config.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "check": "npm run build && npm test && npm run typecheck",
    "eval:hosts": "node scripts/eval-hosts.mjs",
    "capture:widget": "node scripts/capture-widget.mjs"
  }
  ```

  Pin the versions from the global tech stack. Pin `@types/react` 19.2.18,
  `@types/react-dom` 19.2.4, and `@types/express` 5.0.6. Put React, React DOM, RSC, MCP SDK,
  Ext Apps, Zod, and Express in `dependencies`; put Rsbuild, its React/RSC plugins, Rstest, the type
  packages, and Playwright Core in `devDependencies`. Run `npm install` from the repo root and retain
  the lockfile update.

- [ ] **Step 2: Write failing kernel and static-definition tests**

  The kernel test must create two `RuntimeKernel` instances over the same temporary JSONL path,
  write through the first, and read through the second:

  ```ts
  const first = createFileRuntimeKernel({
    stateFile,
    now: () => new Date('2026-08-14T12:00:00.000Z'),
    createId: () => 'edit-1',
  });
  const second = createFileRuntimeKernel({ stateFile });

  await first.recordEdit({
    host: 'claude',
    sessionId: 'session-1',
    toolName: 'Write',
    path: 'src/runtime/state-file.ts',
  });

  expect(await second.readSnapshot()).toMatchObject({
    stateVersion: 1,
    edits: [{ eventId: 'edit-1', host: 'claude', path: 'src/runtime/state-file.ts' }],
  });
  ```

  Add cases for `limit`, one trailing partial JSONL line, and a valid empty file. The definition test
  must assert the exact three tool names, the two native hook matcher strings, the versioned resource
  URI, accurate read-only annotations, and that only `render_edit_timeline` has `ui.resourceUri`
  plus the matching `openai/outputTemplate` alias. Assert resource metadata includes
  `ui.prefersBorder: true`, empty `ui.csp.connectDomains`/`resourceDomains`, and the exact
  `openai/widgetDescription` value `Interactive timeline of file edits recorded by agent hooks.` It
  must serialize the definition, recursively reject functions, and assert that input/output schemas
  are JSON Schema objects.

- [ ] **Step 3: Run the focused tests and verify red**

  Run:

  ```bash
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/state-and-definition.test.ts
  ```

  Expected: failure because `state-file.ts`, `definition.ts`, and their exports do not exist.

- [ ] **Step 4: Implement contracts, the JSONL kernel, and the serializable registry**

  Define these exact core shapes:

  ```ts
  export interface EditEvent {
    eventId: string;
    host: 'claude' | 'codex';
    sessionId: string;
    toolName: string;
    path: string;
    recordedAt: string;
  }

  export interface RuntimeSnapshot {
    stateVersion: number;
    edits: EditEvent[];
  }

  export interface RuntimeKernel {
    recordEdit(input: Omit<EditEvent, 'eventId' | 'recordedAt'>): Promise<RuntimeSnapshot>;
    readSnapshot(options?: { limit?: number }): Promise<RuntimeSnapshot>;
  }

  export interface CanonicalPostToolUse {
    host: 'claude' | 'codex';
    sessionId: string;
    cwd: string;
    toolName: string;
    path: string;
  }

  export type RenderRequest = {
    type: 'hook/after-file-edit';
    stateFile: string;
    event: CanonicalPostToolUse;
  };

  export type McpTimeline = RuntimeSnapshot;
  ```

  `recordEdit` must create the parent directory, append exactly one JSON object plus `\n`, and return
  a fresh snapshot. `readSnapshot` must return valid complete lines in chronological order and apply
  `limit` from the end. Validate `limit` as an integer from 1 through 50.

  Define Zod input/output schemas next to the exact descriptors for `recent_edits`,
  `render_edit_timeline`, and `runtime_status`. Keep executable handler IDs as strings. Convert Zod
  objects with `z.toJSONSchema` in `serializeRuntimeDefinition`, stripping the top-level `$schema`
  so the generated manifest matches MCP descriptor shape.

- [ ] **Step 5: Run the focused tests and example typecheck**

  Run:

  ```bash
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/state-and-definition.test.ts
  npm run typecheck -w @agent-bundle/rsc-agent-runtime-demo
  ```

  Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

  ```bash
  git add package.json package-lock.json examples/rsc-agent-runtime
  git commit -m "feat(example): define shared agent runtime state"
  ```

### Task 2: Real Flight hook renderer and native host lowering

**Files:**
- Create: `examples/rsc-agent-runtime/rsbuild.config.ts`
- Create: `examples/rsc-agent-runtime/src/runtime/request-context.ts`
- Create: `examples/rsc-agent-runtime/src/runtime/elements.tsx`
- Create: `examples/rsc-agent-runtime/src/runtime/lower-hook.ts`
- Create: `examples/rsc-agent-runtime/src/rsc/components.tsx`
- Create: `examples/rsc-agent-runtime/src/rsc/routes.tsx`
- Create: `examples/rsc-agent-runtime/src/rsc/worker.tsx`
- Create: `examples/rsc-agent-runtime/src/rsc/client-anchor.ts`
- Create: `examples/rsc-agent-runtime/src/types/react-server-dom-rspack.d.ts`
- Create: `examples/rsc-agent-runtime/src/flight/request-render.ts`
- Create: `examples/rsc-agent-runtime/src/hook/normalize.ts`
- Create: `examples/rsc-agent-runtime/src/hook/cli.ts`
- Test: `examples/rsc-agent-runtime/tests/rsc-hook.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `createFileRuntimeKernel`, `CanonicalPostToolUse`, `RuntimeSnapshot`, and `RenderRequest`.
- Produces: `withRenderContext(context, operation)`, `useEdit()`, and `useRuntimeSnapshot()`.
- Produces: `requestFlightRender(request: RenderRequest): Promise<React.ReactNode>`.
- Produces: `lowerHookResult(node: React.ReactNode): NativePostToolUseOutput`.
- Produces executable: `dist/hook/index.js --host claude|codex`.

- [ ] **Step 1: Write a failing built-bundle hook integration test**

  Spawn the future hook entry with a deterministic Claude input and an explicit temporary
  `AGENT_RUNTIME_STATE_FILE`:

  ```ts
  const result = await runHook('claude', {
    session_id: 'claude-session',
    cwd: workspace,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: `${workspace}/demo.txt`, content: 'hello\n' },
    tool_response: { success: true },
    tool_use_id: 'tool-1',
  });

  expect(JSON.parse(result.stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: 'Recorded demo.txt from claude. Shared state now contains 1 edit.',
    },
  });
  ```

  Invoke the same built entry with a Codex `apply_patch` input whose `tool_input.command` contains
  `*** Add File: second.txt`; assert the second output says `2 edits` and the JSONL file contains both
  hosts. Add a negative test for an unsupported native input that exits nonzero with empty stdout.

- [ ] **Step 2: Run build plus the focused test and verify red**

  Run:

  ```bash
  npm run build -w @agent-bundle/rsc-agent-runtime-demo
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/rsc-hook.integration.test.ts
  ```

  Expected: build failure because `rsbuild.config.ts` and the RSC entries are absent.

- [ ] **Step 3: Implement the RSC request context and result elements**

  Back `useEdit` and `useRuntimeSnapshot` with one `AsyncLocalStorage<RenderContext>`. Throw the
  exact error `RSC runtime hook used outside a render request` when no store exists. Define intrinsic
  result elements through components so author code uses:

  ```tsx
  <Hook.Result>
    <Hook.AdditionalContext>text</Hook.AdditionalContext>
  </Hook.Result>
  ```

  The server components must render the intrinsic names `agent-hook-result` and
  `agent-hook-additional-context`. `lowerHookResult` must accept only that tree, flatten string/number
  children, reject duplicate result roots, and return the exact `PostToolUse` native JSON shape.

- [ ] **Step 4: Implement the RSC worker, Flight decoder, and host normalization**

  `worker.tsx` must read one JSON request from stdin, normalize the state-file path, perform the edit
  action, create the component under `withRenderContext`, call `renderToReadableStream`, and pipe the
  stream to stdout while the async context remains active.

  `request-render.ts` must spawn `node ../rsc/index.js` relative to its compiled `import.meta.url`,
  write the request to stdin, convert child stdout with `Readable.toWeb`, and decode with
  `createFromReadableStream`. Include child stderr in a thrown error only after the child exits
  nonzero.

  `normalize.ts` must:

  - read Claude `Write|Edit` paths from `tool_input.file_path`;
  - read Codex `apply_patch` paths from the first `*** Add File:`, `*** Update File:`, or
    `*** Delete File:` header in `tool_input.command`;
  - resolve absolute paths relative to native `cwd` for display/storage;
  - reject non-`PostToolUse` events and empty paths.

  `cli.ts` must read stdin completely, select the normalizer from `--host`, request the Flight
  render, lower it, and write exactly one JSON line.

  Copy the minimal ambient module declarations for `server.node` and `client.node` from the pinned
  `rsbuild-plugin-rsc` 0.1.1 type fixture so TypeScript describes the exact
  `renderToReadableStream` and `createFromReadableStream` calls without using `any`.

- [ ] **Step 5: Configure Rsbuild's real RSC and Node decoder environments**

  Use `pluginReact()` and `pluginRSC({ environments: { server: 'rsc', client: 'widget' } })`.
  Configure one paired Node server compiler named `rsc` with separate `rsc/index` and `hook/index`
  entries; put only `worker.tsx` in `Layers.rsc`. Configure the paired browser compiler named
  `widget` with matching inert `rsc/index` and `hook/index` client anchors so the emitted Node hook
  receives the generated `serverConsumerModuleMap`. Keep this paired client compiler as manifest
  machinery; Task 3 must not replace it with the visible app. Use stable, unhashed entry filenames
  so the result is still two independent Node executables at `dist/rsc/index.js` and
  `dist/hook/index.js`.

  Under `tools.rspack.module.rules`, add exactly one rule matching
  `src/flight/request-render.ts` with `parser: { importMeta: { url: false } }`. Do not use a global
  parser override: runtime-relative worker launching needs preservation only in that launcher.

- [ ] **Step 6: Run the focused test twice and typecheck**

  Run:

  ```bash
  npm run build -w @agent-bundle/rsc-agent-runtime-demo
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/rsc-hook.integration.test.ts
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/rsc-hook.integration.test.ts
  npm run typecheck -w @agent-bundle/rsc-agent-runtime-demo
  ```

  Expected: both runs pass, proving no test depends on a surviving worker or module cache.

- [ ] **Step 7: Commit**

  ```bash
  git add examples/rsc-agent-runtime
  git commit -m "feat(example): render native hooks through RSC Flight"
  ```

### Task 3: Static MCP registry, protocol lowering, and React MCP App

**Files:**
- Modify: `examples/rsc-agent-runtime/rsbuild.config.ts`
- Modify: `examples/rsc-agent-runtime/src/runtime/contracts.ts`
- Modify: `examples/rsc-agent-runtime/src/runtime/elements.tsx`
- Modify: `examples/rsc-agent-runtime/src/rsc/components.tsx`
- Modify: `examples/rsc-agent-runtime/src/rsc/routes.tsx`
- Create: `examples/rsc-agent-runtime/src/runtime/lower-mcp.ts`
- Create: `examples/rsc-agent-runtime/src/mcp/handlers.ts`
- Create: `examples/rsc-agent-runtime/src/mcp/resolve-state.ts`
- Create: `examples/rsc-agent-runtime/src/mcp/create-server.ts`
- Create: `examples/rsc-agent-runtime/src/mcp/stdio.ts`
- Create: `examples/rsc-agent-runtime/src/mcp/http.ts`
- Create: `examples/rsc-agent-runtime/src/widget/App.tsx`
- Create: `examples/rsc-agent-runtime/src/widget/index.tsx`
- Create: `examples/rsc-agent-runtime/src/widget/styles.css`
- Create: `examples/rsc-agent-runtime/src/build/emit-artifacts.ts`
- Test: `examples/rsc-agent-runtime/tests/mcp-lowering.test.tsx`
- Test: `examples/rsc-agent-runtime/tests/mcp-transports.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 static descriptors/kernel and Task 2 `requestFlightRender`.
- Produces: `lowerMcpResult(node: React.ReactNode): CallToolResult`.
- Produces: `createRuntimeMcpServer(options?: { stateFile?: string; widgetHtml?: string }): McpServer`.
- Produces executables: `dist/mcp/stdio.js` and `dist/mcp/http.js`.
- Produces artifacts: `dist/runtime/agent-runtime.manifest.json`, `dist/app/edit-timeline-v1.html`, and `dist/app/standalone.html`.

- [ ] **Step 1: Write failing tests for every MCP result element**

  Render/lower one tree containing all supported blocks in order:

  ```tsx
  <Mcp.Result structuredContent={{ stateVersion: 2 }} isError={false}>
    <Mcp.Text>two edits</Mcp.Text>
    <Mcp.Image data="iVBORw0KGgo=" mimeType="image/png" />
    <Mcp.Audio data="UklGRg==" mimeType="audio/wav" />
    <Mcp.ResourceLink uri="file:///demo.txt" name="demo.txt" mimeType="text/plain" />
    <Mcp.EmbeddedResource uri="runtime://snapshot" mimeType="application/json">
      {'{"stateVersion":2}'}
    </Mcp.EmbeddedResource>
  </Mcp.Result>
  ```

  Assert exact native content blocks, ordered content, `structuredContent`, and `isError`. Add
  rejection cases for missing MIME/data, both text and blob on an embedded resource, nested result
  roots, and non-serializable `structuredContent`.

- [ ] **Step 2: Write failing stdio and HTTP integration tests**

  Seed state with the Task 1 kernel, connect an MCP SDK `Client` through `StdioClientTransport`, and
  assert:

  - `tools/list` returns exactly `recent_edits`, `render_edit_timeline`, and `runtime_status`;
  - `recent_edits` returns the seed in both text and `structuredContent`;
  - `runtime_status` returns a PNG image block from the RSC route;
  - `resources/list` includes the versioned `ui://` URI;
  - `resources/read` returns `text/html;profile=mcp-app` and inlined widget markup.

  Start `dist/mcp/http.js` with `PORT=0`, parse its one-line startup JSON from stderr, connect a
  `StreamableHTTPClientTransport` to `/mcp`, and repeat the tool/resource list assertions. Close the
  client and server and assert the child exits cleanly.

  Also assert `dist/app/edit-timeline-v1.html` and `dist/app/standalone.html` each contain their
  JavaScript and CSS inline and do not reference external app bundle assets.

- [ ] **Step 3: Run focused tests and verify red**

  Run:

  ```bash
  npm run build -w @agent-bundle/rsc-agent-runtime-demo
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/mcp-lowering.test.tsx tests/mcp-transports.integration.test.ts
  ```

  Expected: failure because MCP elements, transports, and widget artifacts do not exist.

- [ ] **Step 4: Implement complete protocol lowering and RSC MCP routes**

  Add intrinsic components named `mcp-result`, `mcp-text`, `mcp-image`, `mcp-audio`,
  `mcp-resource-link`, and `mcp-embedded-resource`. Keep their props Flight-serializable. Extend
  `RenderRequest` with `mcp/render-timeline` and `mcp/runtime-status` variants.

  `render-timeline` must echo the validated prepared snapshot through `Mcp.Result` plus a text block.
  `runtime-status` must read the shared kernel, return concise structured content and text, and include
  a deterministic valid 1x1 PNG base64 image. Lowering must produce MCP protocol objects only; it
  must not emit HTML or Markdown image syntax.

- [ ] **Step 5: Register the entire MCP surface before transport connection**

  Implement `createRuntimeMcpServer` with `McpServer`, `registerAppTool`, `registerAppResource`, and
  `RESOURCE_MIME_TYPE`. Register descriptors by iterating the static Task 1 definition and selecting
  handlers by handler ID. Register the resource with `ui.prefersBorder: true`, empty CSP domain
  arrays, and `openai/widgetDescription` set to
  `Interactive timeline of file edits recorded by agent hooks.` `recent_edits` reads the kernel
  directly. The two render handlers call the Flight worker and `lowerMcpResult`.

  Resolve state in this order: explicit function option, `AGENT_RUNTIME_STATE_FILE`, first URI from
  `roots/list` when available, then `<process.cwd()>/.agent-runtime-demo/events.jsonl`. A roots failure
  must use the fallback without changing the registered descriptor set.

  Implement stdio with `StdioServerTransport`. Implement stateless HTTP with Express and
  `StreamableHTTPServerTransport` at `POST /mcp`, with `GET /health` returning
  `{ "ok": true, "transport": "streamable-http" }`.

- [ ] **Step 6: Build the React widget from the accepted visual contract**

  Adapt the official MCP App Basics `useApp` pattern. `App.tsx` must own only:

  ```ts
  type TimelineState = { stateVersion: number; edits: EditEvent[] };
  type RefreshState = 'idle' | 'refreshing' | 'error';
  ```

  On `app.ontoolresult`, validate and display `structuredContent`. On Refresh, call
  `app.callServerTool({ name: 'recent_edits', arguments: { limit: 10 } })`, validate the returned
  `structuredContent`, and update the mounted list. When `window.parent === window`, render the three
  deterministic concept rows and make Refresh increment a local standalone state version so visual
  QA can exercise the interaction.

  Implement the exact concept copy, open timeline rail, true-white palette, violet focus/hover
  control, keyboard-visible focus, reduced-motion behavior, empty state, and responsive 360px layout.
  Do not add navigation, charts, nested cards, gradients, decorative badges, or new visible labels.

- [ ] **Step 7: Emit the static manifest and self-contained widget resources from Rsbuild**

  Add `mcp/stdio` and `mcp/http` as separate Node entries in the existing `rsc` server compiler so
  both Flight decoders receive the generated RSC consumer manifest. Add matching inert entries to
  the paired `widget` client compiler. Keep the worker launcher's module-rule parser override scoped
  to `src/flight/request-render.ts`.

  Create a separate ordinary browser environment named `app`; it is not the RSC plugin client
  environment. Give it `edit-timeline-v1` and `standalone` entries pointing to
  `src/widget/index.tsx`, target `web`, and output root `dist/app`. Use Rsbuild's native production
  settings `output.inlineScripts: true`, `output.inlineStyles: true`, and `html.inject: 'body'` so
  Rsbuild directly emits self-contained `edit-timeline-v1.html` and `standalone.html`. Do not read,
  concatenate, or rewrite emitted JavaScript or CSS by hand.

  Add a build plugin only to serialize `runtimeDefinition` to
  `dist/runtime/agent-runtime.manifest.json`; it must not manufacture the app HTML.

  The generated manifest must record each executable relative path, exact tool JSON schemas, hook
  matchers, resource MIME/URI/metadata, and `schemaVersion: 1`.

- [ ] **Step 8: Run build, focused tests, and typecheck**

  Run:

  ```bash
  npm run build -w @agent-bundle/rsc-agent-runtime-demo
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/mcp-lowering.test.tsx tests/mcp-transports.integration.test.ts
  npm run typecheck -w @agent-bundle/rsc-agent-runtime-demo
  ```

  Expected: all commands exit 0; no server child remains open after tests.

- [ ] **Step 9: Commit**

  ```bash
  git add examples/rsc-agent-runtime
  git commit -m "feat(example): add RSC MCP server and timeline app"
  ```

### Task 4: Host extensions, dual-host packaging, native evaluations, browser evidence, and documentation

**Files:**
- Modify: `examples/rsc-agent-runtime/package.json`
- Create: `examples/rsc-agent-runtime/packaging/claude/.claude-plugin/plugin.json`
- Create: `examples/rsc-agent-runtime/packaging/claude/.mcp.json`
- Create: `examples/rsc-agent-runtime/packaging/claude/hooks/hooks.json`
- Create: `examples/rsc-agent-runtime/packaging/codex/.agents/plugins/marketplace.json`
- Create: `examples/rsc-agent-runtime/packaging/codex/.codex-plugin/plugin.json`
- Create: `examples/rsc-agent-runtime/packaging/codex/.mcp.json`
- Create: `examples/rsc-agent-runtime/packaging/codex/hooks/hooks.json`
- Create: `examples/rsc-agent-runtime/src/mcp/host-metadata.ts`
- Create: `examples/rsc-agent-runtime/src/widget/host-adapters.ts`
- Modify: `examples/rsc-agent-runtime/src/widget/App.tsx`
- Create: `examples/rsc-agent-runtime/scripts/package-hosts.mjs`
- Create: `examples/rsc-agent-runtime/scripts/eval-hosts.mjs`
- Create: `examples/rsc-agent-runtime/scripts/capture-widget.mjs`
- Create: `examples/rsc-agent-runtime/README.md`
- Test: `examples/rsc-agent-runtime/tests/host-extensions.test.tsx`
- Test: `examples/rsc-agent-runtime/tests/host-artifacts.test.ts`

**Interfaces:**
- Consumes: Task 2 hook executable and Task 3 MCP executables/widget resource.
- Produces: self-contained `dist/plugins/claude` and `dist/plugins/codex` artifacts for Claude Code
  2.1.232 and Codex CLI 0.147.0.
- Produces: `npm run eval:hosts -w @agent-bundle/rsc-agent-runtime-demo -- --host all` JSON summary.
- Produces: `npm run capture:widget -w @agent-bundle/rsc-agent-runtime-demo -- --output <png>` visual evidence.

- [ ] **Step 1: Write failing host-artifact contract tests**

  Run the host packager over a built runtime. Assert both materialized manifests identify
  `rsc-agent-runtime`, use strict semver `0.1.0`, use native conventional MCP/hook paths, and
  reference only files contained in their own artifact. Assert:

  ```json
  {
    "claudeMcpArg": "${CLAUDE_PLUGIN_ROOT}/runtime/mcp/stdio.js",
    "codexMcpArg": "./runtime/mcp/stdio.js",
    "claudeHookMatcher": "Write|Edit",
    "codexHookMatcher": "apply_patch|Write|Edit"
  }
  ```

  Reject `PLUGIN_ROOT`, `PLUGIN_DATA`, or workspace placeholders anywhere in the materialized Codex
  `.mcp.json`. Assert its `cwd` is `./`; its hook command uses native `${PLUGIN_ROOT}` and selects
  `--host codex`. Assert Claude uses `${CLAUDE_PLUGIN_ROOT}` and `--host claude`. Neither config may
  mention an API key.

  Assert the Codex manifest has its required `interface`, `skills: "./skills/"`,
  `mcpServers: "./.mcp.json"`, and `hooks: "./hooks/hooks.json"`; the artifact must contain all four
  paths plus `.agents/plugins/marketplace.json`. Assert Claude strict validation targets the separate
  Claude artifact, not the example root.

  Parse the source `dist/runtime/runtime-assets.json`. Assert each materialized host artifact has an
  exact `runtime/` copy of every listed initial, async, and source-map asset, including at least one
  `runtime/chunks/*.js` file, plus `app/edit-timeline-v1.html`. Copy one materialized plugin to a
  fresh temporary directory without the example's source `dist`, launch its stdio MCP executable,
  and prove the declared async chunk resolves there.

  Assert the supplemental-runtime boundary: `packages/agent-bundle/package.json` has no React,
  `react-server-dom-rspack`, or `rsbuild-plugin-rsc` runtime/peer/optional dependency, and no source
  under `packages/agent-bundle/src` imports from this example or those RSC packages.

  In `host-extensions.test.tsx`, first assert the portable failure boundary: with no
  `window.openai` and no public MCP URL, the widget still initializes through MCP Apps, row
  selection remains local, and the resource contains no host domain. Then mock only the documented
  `widgetState` and `setWidgetState` capabilities and assert a valid selected event ID is restored
  and the next selection is synchronously persisted. Assert malformed host state is ignored.

  Given `https://example.com/mcp`, assert the Claude resource-domain helper returns exactly the
  first 32 hex characters of SHA-256 of that URL plus `.claudemcpcontent.com`; assert it is applied
  at resource-content `_meta.ui.domain`, not tool registration. Assert arbitrary serializable
  namespaced metadata survives descriptor/resource and tool-result paths unchanged and never
  replaces complete model-visible `content`/`structuredContent`.

  Feed a Claude-compatible standard host context with dark theme, style variables, mobile platform,
  and nonzero safe-area insets. Assert the SDK host-style path updates document theme/variables and
  the timeline exposes the insets without any `window.claude`, user-agent, or product-name branch.

- [ ] **Step 2: Run the focused test and verify red**

  Run:

  ```bash
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/host-extensions.test.tsx tests/host-artifacts.test.ts
  ```

  Expected: failure because manifests and hook configs are absent.

- [ ] **Step 3: Create host templates and materialize self-contained native artifacts**

  Give both manifests the same identity and description. Claude uses its native compact manifest.
  Codex must additionally include its schema-required `interface` object with display/short/long
  descriptions, developer name, `Productivity` category, `mcp`/`hooks` capabilities, and one default
  prompt, plus these conventional fields:

  ```json
  {
    "name": "rsc-agent-runtime",
    "version": "0.1.0",
    "description": "RSC hooks, shared state, MCP tools, and an MCP App in one runtime demo.",
    "author": { "name": "Agent Bundle" },
    "mcpServers": "./.mcp.json",
    "hooks": "./hooks/hooks.json",
    "skills": "./skills/"
  }
  ```

  Both MCP files use their native wrapped `mcpServers` object. Claude launches
  `${CLAUDE_PLUGIN_ROOT}/runtime/mcp/stdio.js`; Codex uses `cwd: "./"` and
  `./runtime/mcp/stdio.js`. Both hook configs use synchronous `PostToolUse` handlers and select the
  correct `--host`; Claude uses `${CLAUDE_PLUGIN_ROOT}`, while Codex hooks use `${PLUGIN_ROOT}`.

  Add `package-hosts.mjs`. It must delete only the exact `dist/plugins` directory, recreate each
  plugin root, copy the appropriate template, copy the complete `dist/runtime` artifact root to
  `<plugin>/runtime`, copy `dist/app` to `<plugin>/app`, and create Codex's conventional `skills/`
  directory. It must verify every normalized `runtime-assets.json` path stays within and exists in
  the copied runtime root. It must never recursively copy `dist/plugins` into itself. Add
  `package:hosts` and run it after `rsbuild build` in the example's `build` script.

- [ ] **Step 4: Implement the host-extension lanes and progressive fallbacks**

  Add `host-metadata.ts` with pure functions that merge serializable namespaced metadata without
  interpreting vendor keys and compute the documented Claude stable app domain only from an
  explicitly supplied public MCP URL. Wire the optional domain into the resource content returned
  by `resources/read`; do not add it to the registration descriptor and do not set it by default.

  Add a small widget adapter interface for recoverable presentation state. Its portable adapter
  keeps `selectedEventId` in the mounted React instance. Its OpenAI adapter exists only when both
  `window.openai.widgetState` and `window.openai.setWidgetState` have the documented shapes; it
  restores only an ID present in the current timeline and calls `setWidgetState` synchronously after
  selection. Capability detection must not inspect a user agent or host/product name.

  Call the SDK's `useHostStyles(app, app?.getHostContext())` and subscribe to standard host-context
  changes for layout values. Express structural colors and font families as MCP Apps CSS variables
  with the accepted concept colors/fonts as fallbacks. Apply safe-area padding through scoped CSS
  custom properties so Claude web/desktop/mobile contexts and other compliant hosts use the same
  component. Do not hardcode Anthropic-specific variables or introduce a Claude browser global.

  Make timeline rows keyboard-selectable without adding visible copy or controls. The selected row
  may use the existing violet accent and an accessible state, but must preserve the accepted open
  rail/list anatomy. Keep Refresh on the standard MCP Apps `tools/call` route. Extend MCP result
  lowering to preserve optional serializable `_meta`, while keeping `content` and
  `structuredContent` sufficient for text-only hosts.

  Run the focused extension and transport tests in both modes: no vendor globals and a minimal
  mocked OpenAI capability object. The Claude proof is the standards-only bridge plus the
  deterministic optional resource domain and native Claude package; the Codex proof is its native
  manifest/hook/MCP artifact. Do not claim either CLI renders an iframe.

- [ ] **Step 5: Verify and commit the host-extension slice**

  Run:

  ```bash
  npm run build -w @agent-bundle/rsc-agent-runtime-demo
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/host-extensions.test.tsx tests/mcp-lowering.test.tsx tests/mcp-transports.integration.test.ts
  npm run typecheck -w @agent-bundle/rsc-agent-runtime-demo
  ```

  Stage only the host metadata/result/widget adapter source and focused tests, leaving packaging,
  evaluation, capture, and README work for the final task commit:

  ```bash
  git add examples/rsc-agent-runtime/src/mcp/host-metadata.ts \
    examples/rsc-agent-runtime/src/mcp/create-server.ts \
    examples/rsc-agent-runtime/src/runtime/contracts.ts \
    examples/rsc-agent-runtime/src/runtime/elements.ts \
    examples/rsc-agent-runtime/src/runtime/lower-mcp.ts \
    examples/rsc-agent-runtime/src/widget/App.tsx \
    examples/rsc-agent-runtime/src/widget/host-adapters.ts \
    examples/rsc-agent-runtime/src/widget/styles.css \
    examples/rsc-agent-runtime/tests/host-extensions.test.tsx
  git commit -m "feat(example): add host extension adapters"
  ```

- [ ] **Step 6: Implement a deterministic native-host evaluation script**

  `eval-hosts.mjs` must:

  - parse `--host claude|codex|all`, defaulting to `all`;
  - verify exact installed versions before running;
  - require the appropriate built `dist/plugins/<host>` artifact, create a fresh temporary Git
    workspace, and use an explicit shared state file per host;
  - run Claude with `claude -p --plugin-dir <dist/plugins/claude> --output-format stream-json --verbose
    --include-hook-events --no-session-persistence --dangerously-skip-permissions`;
  - run Codex with `codex -a never exec --ephemeral --json --dangerously-bypass-hook-trust
    -s workspace-write -C <fixture>` and a temporary local marketplace/plugin installation; `-a`
    is a global Codex option and must appear before `exec` in 0.147.0;
  - for the temporary Codex home, copy `auth.json` opaquely with its original mode when it exists,
    never read or print its contents, and delete the temporary home in `finally`;
  - inherit each CLI's existing session environment without adding provider credential variables;
  - prompt each agent to create exactly `host-created.txt`, call `recent_edits`, pass its snapshot to
    `render_edit_timeline`, and return a final marker containing the host and observed path;
  - parse tool/hook events plus the state file and require evidence of the native edit, hook output,
    MCP read, RSC render tool, and final marker;
  - print one sanitized JSON summary containing versions, booleans, event counts, and elapsed time;
  - exit 1 when either selected host lacks any required evidence.

  The script must not persist raw authentication, account identifiers, prompts from user config, or
  complete native transcripts in the repository.

- [ ] **Step 7: Implement browser capture and interaction verification**

  `capture-widget.mjs` must locate Chrome, serve `dist/app/standalone.html` on an ephemeral loopback
  port, launch that installed executable through `playwright-core`, capture 760x500 and 360x640
  screenshots, click Refresh, and assert the visible state version changes from 3 to 4. It accepts
  `--output <desktop.png>` and writes the mobile sibling as `<stem>-mobile.png`. It must close the
  browser and server in `finally`.

  Add a second browser fixture that installs a minimal mocked `window.openai` before the app mounts,
  selects one timeline row, reloads, and proves the selection is restored. Capture this state as an
  additional ChatGPT-extension screenshot. The ordinary desktop/mobile captures must run with no
  vendor global and remain unchanged.

  Add a Claude-compatible host-context fixture through the standard MCP Apps bridge (or a narrowly
  equivalent host-context harness) with dark style variables and safe-area insets. Capture it at a
  mobile width and assert the host variables/insets apply, the Refresh target remains at least
  44x44 CSS pixels, and no horizontal or nested vertical scrolling is introduced.

- [ ] **Step 8: Document the runnable demo and honest support boundaries**

  `README.md` must include:

  - the four-plane architecture and the statement that hook renders are fresh requests;
  - the `useEdit`, `useRuntimeSnapshot`, Hook JSX, and MCP JSX examples;
  - exact build/test/manual-hook/stdio/HTTP commands;
  - the static tool/resource table and result-element mapping;
  - Claude `--plugin-dir` and Codex plugin/evaluation instructions;
  - ChatGPT Developer Mode steps using a public HTTPS tunnel to local `/mcp`, including refresh after
    descriptor changes;
  - the distinction between locally validated MCP App HTTP/resource/browser behavior and an actual
    ChatGPT Developer Mode connection;
  - a host-capability matrix covering portable MCP Apps, ChatGPT/OpenAI aliases and widget state,
    Claude's standard bridge/host styles/safe areas and optional stable app domain, Claude Code
    native packaging, and Codex native packaging; explicitly state that Codex CLI is not the
    ChatGPT UI host;
  - an extension-author guide for descriptor/resource/result `_meta` and client adapters, including
    the rule that fallback behavior remains complete and vendor APIs are feature-detected;
  - the relationship to Agent Bundle's standard non-RSC `mcp.servers.<server>.apps` compiler: use
    that self-contained HTML/virtual-resource lane for ordinary MCP Apps, and opt into this paired
    runtime only when hooks or MCP tool results need RSC Flight/shared runtime behavior;
  - the security boundary for Streamable HTTP: Host/Origin allowlists mitigate rebinding and cross-
    origin requests but do not authenticate a public tunnel; production exposure still requires
    the deployment's authentication and authorization layer;
  - source links for Rsbuild RSC, MCP Apps, OpenAI plugin UI, Claude MCP Apps cross-platform/design
    guidance, Codex hooks, and Claude hooks;
  - known limitations of JSONL storage and exact RSC package pins;
  - an explicit opt-in section explaining that existing Agent Bundle skills, static MCPs,
    evaluations, and normal hooks do not require or activate this runtime.

- [ ] **Step 9: Validate static packaging and run all deterministic checks**

  Run diagnostics before TypeScript, then:

  ```bash
  claude plugin validate --strict examples/rsc-agent-runtime/dist/plugins/claude
  npm run check -w @agent-bundle/rsc-agent-runtime-demo
  npm test -- run packages/agent-bundle/tests/mcp.test.ts
  npm run capture:widget -w @agent-bundle/rsc-agent-runtime-demo -- --output /tmp/rsc-agent-runtime-widget.png
  npm run check
  ```

  Expected: plugin validation, example check, browser interaction, and root check all exit 0.

- [ ] **Step 10: Run installed Claude and Codex evaluations**

  Run:

  ```bash
  npm run eval:hosts -w @agent-bundle/rsc-agent-runtime-demo -- --host all
  ```

  Expected: JSON reports exact versions `2.1.232` and `0.147.0`, with `editObservedByHook`,
  `editObservedByMcp`, `rscRenderToolObserved`, and `finalMarkerObserved` all `true` for both hosts.
  If a host session is not authenticated, record that as an environment limitation; do not request or
  add a key.

- [ ] **Step 11: Compare the accepted concept and browser screenshots**

  Inspect `docs/assets/rsc-agent-runtime-demo/edit-timeline-concept.png`, the standalone desktop and
  mobile screenshots, the ChatGPT-extension screenshot, and the Claude-compatible host-context
  screenshot with `view_image`. Record at least these five checks in the task report:

  1. exact header/support/footer copy;
  2. open rail/list anatomy and three row order;
  3. true-white/cool-gray/violet palette;
  4. mono hierarchy, spacing, and outer radius;
  5. Refresh focus/click behavior and mobile overflow.

  Fix every concrete mismatch before proceeding. The allowed above-the-fold copy is only the concept
  copy plus dynamic filename, host, tool, and timestamp values.

- [ ] **Step 12: Commit the packaging, evaluation, capture, and documentation slice**

  ```bash
  git add examples/rsc-agent-runtime
  git commit -m "docs(example): package and evaluate the RSC agent runtime"
  ```

## Final verification

- [ ] Run fresh TraceDecay diagnostics for the worktree.
- [ ] Run `npm run check -w @agent-bundle/rsc-agent-runtime-demo`.
- [ ] Run root `npm run check`.
- [ ] Confirm the published `agent-bundle` package has no dependency/import/configuration edge to the
      example or its React/RSC packages.
- [ ] Confirm Agent Bundle's existing non-RSC MCP App compilation/resource test remains green and
      the README distinguishes it from the optional paired RSC runtime.
- [ ] Confirm both materialized native artifacts contain every initial and async asset declared by
      `runtime/runtime-assets.json` and execute from an isolated copied directory.
- [ ] Run `claude plugin validate --strict examples/rsc-agent-runtime/dist/plugins/claude`.
- [ ] Run the stdio and Streamable HTTP integration tests with open-handle detection.
- [ ] Run the widget capture at desktop and mobile widths and inspect both screenshots against the accepted concept.
- [ ] Run `npm run eval:hosts -w @agent-bundle/rsc-agent-runtime-demo -- --host all` using installed sessions.
- [ ] Inspect `git diff --check`, `git status --short`, and the complete branch diff.
- [ ] Confirm no provider API key name/value, raw auth content, or transient eval artifact entered the diff.
