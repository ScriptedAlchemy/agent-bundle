import {
  BarChart,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CollapsibleSection,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
  type CSSProperties,
} from "cursor/canvas";

/* ---------------------------------------------------------------- helpers */

const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

function Kicker({ children }: { children: string }) {
  const t = useHostTheme();
  return (
    <Text
      size="small"
      weight="semibold"
      style={{
        color: t.accent.primary,
        letterSpacing: 1.2,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

function MonoBlock({ text, dim }: { text: string; dim?: boolean }) {
  const t = useHostTheme();
  const style: CSSProperties = {
    background: t.fill.quaternary,
    border: `1px solid ${t.stroke.tertiary}`,
    borderRadius: 6,
    color: dim ? t.text.secondary : t.text.primary,
    fontFamily: MONO,
    fontSize: 12,
    lineHeight: "18px",
    margin: 0,
    overflowX: "auto",
    padding: "10px 12px",
    whiteSpace: "pre",
  };
  return <pre style={style}>{text}</pre>;
}

function StageBox({
  title,
  detail,
  emphasized,
}: {
  title: string;
  detail: string;
  emphasized?: boolean;
}) {
  const t = useHostTheme();
  return (
    <div
      style={{
        background: emphasized ? t.fill.tertiary : t.bg.editor,
        border: `1px solid ${emphasized ? t.accent.primary : t.stroke.secondary}`,
        borderRadius: 8,
        flex: 1,
        minWidth: 0,
        padding: "10px 12px",
      }}
    >
      <Text size="small" weight="semibold" style={{ marginBottom: 2 }}>
        {title}
      </Text>
      <Text size="small" tone="tertiary">
        {detail}
      </Text>
    </div>
  );
}

function FlowArrow() {
  const t = useHostTheme();
  return (
    <div
      style={{
        alignSelf: "center",
        color: t.text.quaternary,
        flexShrink: 0,
        fontSize: 14,
        padding: "0 2px",
      }}
    >
      {"\u2192"}
    </div>
  );
}

function StepMarker({ n }: { n: number }) {
  const t = useHostTheme();
  return (
    <div
      style={{
        alignItems: "center",
        background: t.fill.tertiary,
        border: `1px solid ${t.accent.primary}`,
        borderRadius: 999,
        color: t.accent.primary,
        display: "flex",
        flexShrink: 0,
        fontSize: 12,
        fontWeight: 600,
        height: 24,
        justifyContent: "center",
        width: 24,
      }}
    >
      {n}
    </div>
  );
}

function WireStep({
  n,
  title,
  channel,
  payload,
  note,
  last,
}: {
  n: number;
  title: string;
  channel: string;
  payload?: string;
  note?: string;
  last?: boolean;
}) {
  const t = useHostTheme();
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        <StepMarker n={n} />
        {!last && (
          <div
            style={{
              background: t.stroke.secondary,
              flex: 1,
              marginTop: 4,
              width: 1,
            }}
          />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 18 }}>
        <Row gap={8} align="center" wrap>
          <Text weight="semibold">{title}</Text>
          <Text size="small" tone="tertiary" as="span" style={{ fontFamily: MONO }}>
            {channel}
          </Text>
        </Row>
        {note !== undefined && (
          <Text size="small" tone="secondary" style={{ marginTop: 2 }}>
            {note}
          </Text>
        )}
        {payload !== undefined && (
          <div style={{ marginTop: 6 }}>
            <MonoBlock text={payload} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ wire bodies */

const AUTHORED_TREE = `my-plugin/
  agent-bundle.config.ts        defineConfig({ plugin, targets, ... })
  src/
    mcp/curator/tools/search.tsx   MCP tool  (id: tool:curator/search)
    mcp/curator/resources/catalog.tsx
    mcp/curator/prompts/curate.tsx
    mcp/curator/apps/panel.tsx     MCP App (config.resourceUri)
    events/tool/before.tsx         event route (id: event:tool/before)
    events/stop.tsx                event route (id: event:stop)
    providers/build-info.ts        context provider factory
    cli/library/audit.ts           CLI command "library audit"
    scripts/verify-release.ts      plain script -> scripts/*.mjs
    state.ts                       defineState({ id, lifetime, budgets })
  skills/curate/SKILL.md           agent skill (or rendered SKILL.tsx)
  rules/style.mdc                  Cursor rules component
  commands/triage.md               chat command (Claude + Cursor)`;

const TOOL_ROUTE_SNIPPET = `// src/mcp/curator/tools/search_audible.tsx  (examples/audiobook-curator)
export const config = {
  annotations: { openWorldHint: true, readOnlyHint: false },
  description: "Search Audible regions and return ranked identity evidence...",
};                                     // statically extracted, never executed
export const inputSchema  = operation.inputSchema;   // zod, runtime boundary
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal });
  return <CuratorResult receipt={receipt} />;        // renders Agent.* elements
}`;

const EVENT_ROUTE_SNIPPET = `// src/events/tool/after.tsx  (examples/rsc-agent-runtime)
export const config = {
  runtime: 'standalone',        // 'shared' (warm IPC runtime) | 'standalone'
  targets: ['claude', 'codex'],
  timeoutMs: 30_000,            // budget inside the host's native deadline
  tools: ['file.write'],        // canonical selector -> per-host matcher regex
};

export default async function AfterFileEdit({ canonical, native, signal }: AgentEventRouteProps) {
  // canonical.provenance = { host, hostContractRevision, nativeEvent, source: 'native' }
  const snapshot = await kernel.recordEdit({ idempotencyKey: canonical.idempotencyKey, ... });
  return (
    <Agent.Result>
      <Agent.Context>{\`Recorded \${path} from \${canonical.provenance.host}.\`}</Agent.Context>
    </Agent.Result>
  );
}`;

const CLAUDE_HOOKS_JSON = `// claude/hooks/hooks.json - real emitted bytes (examples/hooks-and-scripts)
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "command": "node \\"\${CLAUDE_PLUGIN_ROOT}/hooks/session-start-session-start-7ab7e8a5.mjs\\"",
            "type": "command"
          }
        ]
      }
    ]
  }
}
// Cursor keeps a flat document instead:
// { "version": 1, "hooks": { "preToolUse": [ { "command": "node \\"\${CURSOR_PLUGIN_ROOT}/...\\"", "matcher": "^Write$" } ] } }`;

const WIRE_STDIN = `{
  "hook_event_name": "PreToolUse",
  "session_id": "6f9a2c1e-4d15-4a44-9be2-6b8f0f6f2a10",
  "transcript_path": "/home/dev/.claude/projects/acme/transcript.jsonl",
  "cwd": "/home/dev/acme",
  "permission_mode": "default",
  "tool_name": "Write",
  "tool_input": { "file_path": "src/payments.ts", "content": "..." },
  "tool_use_id": "toolu_01H8KQ2ZC4"
}`;

const WIRE_IPC_REQUEST = `{
  "protocolVersion": 1,
  "artifactEpoch": "17903a885df8d142e2fc4457e61bb34479e81a8f4cc64e24cb92db49eaabe3f1",
  "event": "tool/before",
  "hostContractRevision": "2.1.250",
  "target": "claude",
  "native": { ...the validated stdin envelope, value-preserving (re-serialized JSON, not raw bytes)... }
}
// socket: /tmp/agent-bundle-<uid>/event-<sha256(endpointId)[0..32]>.sock   (mode 0600)
// endpointId = "<artifactEpoch>:<target>:<artifact root dir>" - two installs never share a runtime`;

const WIRE_RENDER_PROPS = `props = {
  canonical: {
    event: "tool/before",
    idempotencyKey: sha256({ event, native, target }),
    observedAt: "2026-09-01T23:41:07.512Z",
    provenance: { host: "claude", hostContractRevision: "2.1.250",
                  nativeEvent: "PreToolUse", source: "native" },
    sequence: 1,
  },
  native: { ...frozen structuredClone of the envelope... },
  signal,  // aborted when the socket drops or the client times out
}
// runAgentRequest installs host/session/workspace axes read from the envelope,
// then the react-server Flight worker renders the route's default component.`;

const WIRE_IPC_RESPONSE = `{
  "protocolVersion": 1,
  "artifactEpoch": "17903a88...eaabe3f1",
  "status": "ok",
  "output": {
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "payments.ts is frozen during release week"
    }
  }
}
// on failure: { "status": "error", "code": "epoch-mismatch" | "invalid-message" | "runtime-failed", ... }`;

const WIRE_STDOUT = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"payments.ts is frozen during release week"}}`;

const STATE_SNIPPET = `// src/state.ts - one direct defineState call (AB4818 otherwise)
export default defineState({
  id: 'library-index',
  lifetime: 'workspace-durable',   // request | process | workspace-durable | external
  budgets: { maxStateBytes: 262144, maxRevisions: 64 },  // fail closed: budget-exceeded
});`;

/* ------------------------------------------------------------------ page */

export default function AgentBundleWalkthrough() {
  const t = useHostTheme();

  return (
    <Stack gap={20} style={{ margin: "0 auto", maxWidth: 1060, padding: "28px 32px 48px" }}>
      {/* ============================================================ hero */}
      <Stack gap={8}>
        <Kicker>Framework walkthrough</Kicker>
        <H1>agent-bundle, end to end</H1>
        <Text tone="secondary" style={{ fontSize: 15, lineHeight: "22px", maxWidth: 860 }}>
          Author agent behavior as React Server Components; compile it into a
          route-graph IR; emit native, independently distributable artifacts
          for each host; and execute hooks and MCP tools as Flight renders
          against a warm runtime. Flight is an internal transport only — the
          hosts see their own native JSON contracts, pinned by revision.
        </Text>
        <Row gap={16} wrap style={{ marginTop: 6 }}>
          <Stat value="7" label="Canonical event families (v1)" />
          <Stat value="4" label="Host targets (claude, codex, cursor, portable)" />
          <Stat value="7" label="Route kinds in the compiled graph" />
          <Stat value="1 MiB" label="Native payload cap per hook event" />
          <Stat value="5 s" label="Default hook IPC deadline" />
        </Row>
      </Stack>

      {/* ======================================================== pipeline */}
      <Stack gap={10}>
        <H2>The pipeline: author → compile → emit → install → execute</H2>
        <Row gap={6} align="stretch">
          <StageBox
            title="Author"
            detail="agent-bundle.config.ts + file-convention routes under src/; skills, rules, commands as documents"
          />
          <FlowArrow />
          <StageBox
            title="Compile"
            detail="compileRouteGraph builds a deep-frozen IR; config exports parsed statically, never executed"
          />
          <FlowArrow />
          <StageBox
            title="Validate"
            detail="Structured AB-code diagnostics; only errors gate; warnings and infos never block"
          />
          <FlowArrow />
          <StageBox
            title="Build"
            detail="Rslib/rspack bundles entries + sibling react-server Flight workers; epoch token baked in"
            emphasized
          />
          <FlowArrow />
          <StageBox
            title="Emit"
            detail="Per-host adapters project manifests, hooks.json, .mcp.json against pinned host schemas"
          />
          <FlowArrow />
          <StageBox
            title="Install + run"
            detail="Host plugin CLIs or staged copy; hooks and tools execute as Flight renders"
          />
        </Row>
        <Text size="small" tone="tertiary">
          Source: packages/agent-bundle/src — routes/graph.ts, config/validate.ts,
          build/entries.ts + entry-shell.ts, adapters/*, install/install.ts.
        </Text>
      </Stack>

      <Divider />

      {/* ======================================================= authoring */}
      <Stack gap={12}>
        <H2>1 · Authoring model: files are the app</H2>
        <Text tone="secondary" style={{ maxWidth: 860 }}>
          One flat config owns identity and policy; everything executable is a
          conventional file whose path is its identity. A generated MCP tool,
          resource, or prompt route module is one async default Server Component
          plus statically extractable
          <Text as="span" weight="semibold"> config</Text>,
          <Text as="span" weight="semibold"> inputSchema</Text>, and
          <Text as="span" weight="semibold"> resultSchema</Text> exports — there is no
          execute/render split (exporting either is the AB4811 error). Other
          route kinds (events, CLI commands, skills) carry their own export
          contracts.
        </Text>
        <Grid columns="1fr 1fr" gap={12} align="start">
          <Card>
            <CardHeader>Conventional source tree</CardHeader>
            <CardBody style={{ padding: 0 }}>
              <MonoBlock text={AUTHORED_TREE} dim />
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill size="sm">real route</Pill>}>
              src/mcp/curator/tools/search_audible.tsx
            </CardHeader>
            <CardBody style={{ padding: 0 }}>
              <MonoBlock text={TOOL_ROUTE_SNIPPET} />
            </CardBody>
          </Card>
        </Grid>
        <H3>Route kinds compiled into the graph</H3>
        <Table
          headers={["Kind", "Convention", "Identity example", "Executes as"]}
          rows={[
            ["tool / resource / prompt / app", <Text as="span" style={{ fontFamily: MONO }} size="small">src/mcp/&lt;server&gt;/&#123;tools,resources,prompts,apps&#125;/*.tsx</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">tool:curator/search</Text>, "Flight render in the generated MCP server"],
            ["event-route", <Text as="span" style={{ fontFamily: MONO }} size="small">src/events/&lt;family&gt;/*.tsx, src/events/stop.tsx</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">event:tool/before</Text>, "Hook wrapper → IPC → warm runtime (or standalone)"],
            ["cli", <Text as="span" style={{ fontFamily: MONO }} size="small">src/cli/**/*.ts(x) — nesting is the command path</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">cli:library/audit</Text>, "Generated package bin; .tsx renders via dispatcher"],
            ["script", <Text as="span" style={{ fontFamily: MONO }} size="small">src/scripts/*.ts(x) — direct children only</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">script:verify-release</Text>, "scripts/<name>.mjs (+ -flight.mjs worker when rendered)"],
            ["provider", <Text as="span" style={{ fontFamily: MONO }} size="small">src/providers/*.ts — factory, not addressable</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">provider:build-info</Text>, "Wraps every render with request-scoped context values"],
          ]}
        />
        <Text size="small" tone="tertiary">
          Source: routes/graph.ts routeGlobs + classifyModule; routes/types.ts. Config always
          wins: modules claimed by explicit scripts/hooks/bin/lib/mcp config never become routes.
        </Text>
      </Stack>

      <Divider />

      {/* ===================================================== compile+val */}
      <Stack gap={12}>
        <H2>2 · Compile and validate: one immutable IR, structured diagnostics</H2>
        <Text tone="secondary" style={{ maxWidth: 860 }}>
          Discovery globs the conventional roots, rejects unsafe identity
          segments, and refuses to choose sides on any collision — an MCP
          server with both discovered routes and an explicit entry is a hard
          AB4800 error until <Text as="span" style={{ fontFamily: MONO }}>routes.servers.&lt;id&gt;</Text> picks
          a mode. The graph digest covers only project-relative identity, so equal
          trees hash equally on every machine. Every failure is one diagnostic:
          stable AB code, severity, message, and usually a recovery hint.
        </Text>
        <CollapsibleSection title="Diagnostic code families (AB0000–AB9999)" count={14}>
          <Table
            framed={false}
            headers={["Family", "Area"]}
            rows={[
              [<Text as="span" style={{ fontFamily: MONO }} size="small">AB30xx</Text>, "Skill documents: Markdown parsing and rendered-skill compilation"],
              [<Text as="span" style={{ fontFamily: MONO }} size="small">AB40xx</Text>, "Plugin metadata, skill fields, package identity (AB4008 version mismatch)"],
              [<Text as="span" style={{ fontFamily: MONO }} size="small">AB41xx / AB42xx</Text>, "Normalized-model invariants; hook configuration and native hook sources"],
              [<Text as="span" style={{ fontFamily: MONO }} size="small">AB43xx / AB44xx / AB46xx</Text>, "MCP servers and Apps; scripts; assets and the generated-runtime floor"],
              [<Text as="span" style={{ fontFamily: MONO }} size="small">AB47xx</Text>, "Package build (bin/lib, AB4716 declaration replay), migration nudges, prebuilt payloads"],
              [<Text as="span" style={{ fontFamily: MONO }} size="small">AB48xx</Text>, "Route graph: collisions AB4800–AB4803, static config grammar AB4805/AB4806, route contract AB4810/AB4811, event vocabulary + CLI command-graph collisions AB4813, CLI argv grammar AB4814, shared-runtime placement AB4817, state AB4818–AB4821"],
              [<Text as="span" style={{ fontFamily: MONO }} size="small">AB494x</Text>, "Providers: default-factory contract, key uniqueness, reserved processLifetime"],
              [<Text as="span" style={{ fontFamily: MONO }} size="small">AB5000 / AB60xx</Text>, "CLI and adapter failures; built-artifact validation against pinned schemas"],
              [<Text as="span" style={{ fontFamily: MONO }} size="small">AB70xx</Text>, "Host installation; read-only Doctor probes AB7300–AB7316; dev rebuilds (AB7103)"],
              [<Text as="span" style={{ fontFamily: MONO }} size="small">AB8xxx / AB9xxx</Text>, "Dev server configuration; eval selection, harnesses, persisted runs"],
            ]}
          />
          <Text size="small" tone="tertiary" style={{ marginTop: 6 }}>
            Source: docs/diagnostics.md. Only error severity gates a build; warnings and infos never block.
          </Text>
        </CollapsibleSection>
        <Callout tone="info" title="Static extraction, never execution">
          A route's config export is parsed with the TypeScript compiler from a bounded literal
          grammar (object/array/string/number literals, as/satisfies casts). Anything dynamic
          compiles with an empty config beside a named AB4806 error. The same static approach
          projects each CLI route's zod inputSchema onto kebab-case argv options (AB4814 when a
          construct leaves the grammar) — the module's real zod schema still validates at run time.
        </Callout>
      </Stack>

      <Divider />

      {/* ======================================================== emission */}
      <Stack gap={12}>
        <H2>3 · Per-host emission: adapters, pinned contracts, provenance</H2>
        <Text tone="secondary" style={{ maxWidth: 860 }}>
          Each adapter projects the normalized model against a pinned host
          capability table (a JSON file with observed versions, evidence
          strings, and per-event support states) and validates its output
          against pinned host schemas whose sha256 hashes ship in the artifact
          manifest. Every capability is <Text as="span" weight="semibold">supported</Text> or{" "}
          <Text as="span" weight="semibold">unavailable with a written reason</Text> — never a
          silent guess.
        </Text>
        <Table
          headers={["Surface", "Claude 2.1.250", "Codex 0.147.0", "Cursor 2026-08-28", "Portable 1.0.0"]}
          columnAlign={["left", "left", "left", "left", "left"]}
          rows={[
            ["Plugin manifest",
              <Text as="span" style={{ fontFamily: MONO }} size="small">.claude-plugin/plugin.json</Text>,
              <Text as="span" style={{ fontFamily: MONO }} size="small">.codex-plugin/plugin.json</Text>,
              <Text as="span" style={{ fontFamily: MONO }} size="small">.cursor-plugin/plugin.json</Text>,
              <Text as="span" style={{ fontFamily: MONO }} size="small">plugin.json</Text>],
            ["Marketplace",
              <Text as="span" style={{ fontFamily: MONO }} size="small">.claude-plugin/marketplace.json</Text>,
              <Text as="span" style={{ fontFamily: MONO }} size="small">.agents/plugins/marketplace.json</Text>,
              <Text as="span" style={{ fontFamily: MONO }} size="small">.cursor-plugin/marketplace.json</Text>,
              "—"],
            ["Hooks wiring",
              "hooks/hooks.json, grouped { matcher, hooks: [{ type: 'command', command }] }",
              "same grouped shape; hook processes get PLUGIN_ROOT / PLUGIN_DATA",
              "hooks/hooks.json, flat { command, matcher?, timeout? } entries",
              "none — Agent Plugins 1.0.0 defines no hooks"],
            ["MCP registration",
              <Text as="span" style={{ fontFamily: MONO }} size="small">.mcp.json (stdio + streamable HTTP)</Text>,
              <Text as="span" style={{ fontFamily: MONO }} size="small">.mcp.json</Text>,
              <Text as="span" style={{ fontFamily: MONO }} size="small">mcp.json at plugin root</Text>,
              "plugin.json mcp block, ${PLUGIN_ROOT} tokens"],
            ["Skills / rules / commands",
              "skills + commands",
              "skills",
              "skills + rules + commands",
              "skills"],
            ["Path token",
              <Text as="span" style={{ fontFamily: MONO }} size="small">{"${CLAUDE_PLUGIN_ROOT}"}</Text>,
              "relative paths + PLUGIN_ROOT cwd",
              <Text as="span" style={{ fontFamily: MONO }} size="small">{"${CURSOR_PLUGIN_ROOT}"}</Text>,
              <Text as="span" style={{ fontFamily: MONO }} size="small">{"${PLUGIN_ROOT}"}</Text>],
            ["Install",
              "claude plugin marketplace add ./ + install --scope user|project|local",
              "codex plugin add <plugin>@<marketplace> (user scope)",
              "copy to ~/.cursor/plugins/local/<name> (no non-interactive verb)",
              "distribution profile — no single host install location"],
          ]}
        />
        <Text size="small" tone="tertiary">
          Source: src/adapters/capabilities/*.json (observed 2026-08-28…09-01) and src/adapters/&#123;claude,codex,cursor,portable&#125;.ts.
          A composite "plugin" target emits one directory loadable by both Claude and Codex, with a
          universal hook wrapper that discriminates the host at run time via PLUGIN_ROOT.
        </Text>
        <Grid columns="3fr 2fr" gap={16} align="start">
          <Stack gap={6}>
            <Text weight="semibold">Emitted artifact size by target and file kind (bytes)</Text>
            <BarChart
              categories={["claude", "codex", "portable"]}
              series={[
                { name: "generated JSON (manifests, hooks.json)", data: [332, 677, 186] },
                { name: "bundled JS (hook wrappers, scripts)", data: [11364, 11359, 3489] },
                { name: "copied assets", data: [782, 782, 782] },
              ]}
              stacked
              height={210}
              valueSuffix=" B"
            />
            <Text size="small" tone="tertiary">
              X: target directory · Y: total bytes, summed per emitted-file kind. Portable has no
              hook wrapper — its spec defines no hooks. Source: examples/hooks-and-scripts
              dist/agent-bundle.manifest.json.
            </Text>
          </Stack>
          <Stack gap={6}>
            <Text weight="semibold">Provenance in every artifact</Text>
            <Text size="small" tone="secondary">
              agent-bundle.manifest.json records, per emitted file, its sha256 and the exact
              source inputs that produced it, plus the project revision (the artifact epoch),
              each target's adapter revision, and the sha256 of every
              pinned host schema it was validated against. agent-bundle.hooks.json is the
              canonical hook index across targets.
            </Text>
            <Text size="small" tone="tertiary">
              Source: dist/agent-bundle.manifest.json fields files[].sha256, files[].sourceInputs,
              project.revision, targets[].schemas[].
            </Text>
          </Stack>
        </Grid>
      </Stack>

      <Divider />

      {/* ================================================== HOOKS DEEP DIVE */}
      <Stack gap={12}>
        <Kicker>Deep dive</Kicker>
        <H2>4 · The hooks pipeline: what is on the wire at every step</H2>
        <Text tone="secondary" style={{ maxWidth: 880 }}>
          Two authoring shapes share the emitted hooks.json wiring. A{" "}
          <Text as="span" weight="semibold">plain handler hook</Text>{" "}
          (config <Text as="span" style={{ fontFamily: MONO }}>hooks: &#123; sessionStart: &#123; handler &#125; &#125;</Text>)
          compiles into a self-contained wrapper that decodes the native envelope, calls the
          default-export function, and encodes the result — no IPC. An{" "}
          <Text as="span" weight="semibold">event route</Text>{" "}
          (<Text as="span" style={{ fontFamily: MONO }}>src/events/**</Text>) compiles into a thin
          client that forwards the validated envelope over a per-user Unix socket (a named pipe on
          Windows) to the warm runtime living inside the generated MCP server process, where the
          route component renders as a Flight request. The walkthrough below is the event-route
          path for a Claude <Text as="span" style={{ fontFamily: MONO }}>PreToolUse</Text> on a{" "}
          <Text as="span" style={{ fontFamily: MONO }}>tool/before</Text> route.
        </Text>

        <Card>
          <CardHeader trailing={<Pill size="sm">generated wiring</Pill>}>
            What the host actually invokes
          </CardHeader>
          <CardBody style={{ padding: 0 }}>
            <MonoBlock text={CLAUDE_HOOKS_JSON} />
          </CardBody>
        </Card>

        <Stack gap={0} style={{ marginTop: 6 }}>
          <WireStep
            n={1}
            title="Claude writes the native envelope to the wrapper's stdin"
            channel="host → node hooks/<wrapper>.mjs · stdin, one JSON value"
            note="The thin client streams stdin with a hard 1 MiB cap, JSON-parses exactly one value, and validates the envelope per host and per event (session_id, transcript_path, cwd, tool fields...). Any mismatch exits nonzero — fail closed."
            payload={WIRE_STDIN}
          />
          <WireStep
            n={2}
            title="Thin client forwards one newline-delimited request over IPC"
            channel="wrapper → warm runtime · Unix socket, protocolVersion 1"
            note="The endpoint hash binds the artifact epoch, the target, and the artifact's install directory; the socket directory is 0700 and the socket 0600. The request is raced against timeoutMs (default 5000 ms) and aborted if the socket drops."
            payload={WIRE_IPC_REQUEST}
          />
          <WireStep
            n={3}
            title="Warm runtime validates, builds canonical props, renders via Flight"
            channel="event runtime server → react-server Flight worker · worker message"
            note="The server rejects epoch mismatches and malformed messages, then createCanonicalEventProps snapshots the envelope and derives cross-host identity. The route renders inside runAgentRequest with honest host/session/workspace axes; Agent.Context text nodes and the Agent.Result value are all it can say."
            payload={WIRE_RENDER_PROPS}
          />
          <WireStep
            n={4}
            title="projectEventDocument lowers the AgentDocument to the host's schema"
            channel="warm runtime → wrapper · socket reply, one JSON line"
            note="Projection is per event and per host: a denied tool/before becomes hookSpecificOutput.permissionDecision for Claude/Codex but { permission: 'deny', user_message, agent_message } for Cursor; a denied stop becomes { decision: 'block' } or Cursor's followup_message. Undefined means silence."
            payload={WIRE_IPC_RESPONSE}
          />
          <WireStep
            n={5}
            title="Thin client prints the host-native response and exits 0"
            channel="wrapper → Claude · stdout"
            note="Claude blocks the Write and surfaces the reason to the model. If the route had decided to allow it, the wrapper prints an explicit hookSpecificOutput.permissionDecision: 'allow' (optionally with updatedInput / additionalContext); a route that renders no decision prints nothing."
            payload={WIRE_STDOUT}
            last
          />
        </Stack>

        <Grid columns="1fr 1fr" gap={12} align="start">
          <Stack gap={8}>
            <H3>Failure semantics: fail closed, one narrow fallback</H3>
            <Table
              framed
              headers={["Transport error", "Trigger", "Outcome"]}
              rowTone={["warning", "danger", "danger", "danger", "danger"]}
              rows={[
                [<Text as="span" style={{ fontFamily: MONO }} size="small">runtime-unavailable</Text>, "No live socket (connect refused / missing)", "Standalone fallback if the route declares runtime or fallback 'standalone'; otherwise nonzero exit"],
                [<Text as="span" style={{ fontFamily: MONO }} size="small">runtime-timeout</Text>, "No reply within timeoutMs (default 5 s)", "Nonzero exit — never a fabricated response"],
                [<Text as="span" style={{ fontFamily: MONO }} size="small">epoch-mismatch</Text>, "Wrapper and runtime built from different artifact epochs", "Nonzero exit; no fallback — stale code never answers"],
                [<Text as="span" style={{ fontFamily: MONO }} size="small">invalid-message</Text>, "Payload over 1 MiB, non-JSON, or off-schema", "Nonzero exit"],
                [<Text as="span" style={{ fontFamily: MONO }} size="small">runtime-failed</Text>, "Render threw, socket error, endpoint contention", "Nonzero exit"],
              ]}
            />
            <Text size="small" tone="tertiary">
              Source: src/events/ipc.ts (EventRuntimeTransportError, requestEventRuntime) and the
              generated wrapper in src/adapters/hook-contract.ts — fallback fires only on
              runtime-unavailable with fallback: 'standalone'.
            </Text>
          </Stack>
          <Stack gap={8}>
            <H3>The standalone path</H3>
            <Text size="small" tone="secondary">
              A route with <Text as="span" style={{ fontFamily: MONO }}>runtime: 'standalone'</Text> (or
              as fallback) bundles the route module into the wrapper itself: the same
              createCanonicalEventProps builds identity, the component resolves in-process
              (Server Components and Agent protocol elements only), and the same
              projectEventDocument lowers the output. No shared state, no warm process —
              identical wire contract to the host.
            </Text>
            <MonoBlock
              dim
              text={`// wrapper decision, baked at compile time
if (runtimeMode === "standalone") output = await runStandalone(native, signal);
else try { output = await requestEventRuntime({ ... }); }
     catch (e) {
       if (fallback === "standalone" && e.code === "runtime-unavailable")
         output = await runStandalone(native, signal);
       else throw e;   // fail closed
     }`}
            />
            <Text size="small" tone="secondary">
              AB4817 guards placement: an event route requiring the shared runtime on a target
              with no generated MCP entry hosting it — and no standalone fallback — fails the build.
            </Text>
          </Stack>
        </Grid>

        <CollapsibleSection title="Socket lifecycle: claiming, orphan reclamation, teardown" defaultOpen={false}>
          <Stack gap={6} style={{ paddingTop: 4 }}>
            <Text size="small" tone="secondary">
              The event runtime server claims its endpoint with an exclusive{" "}
              <Text as="span" style={{ fontFamily: MONO }}>.lock</Text> file recording pid and (on
              Linux) the /proc start time. A stale claim is reclaimed only when its owner is
              provably dead — signal-0 probe plus start-time comparison — and on Linux the
              reclamation itself is serialized through a kernel-released abstract-socket gate, so
              a namespace squatter can force bounded retries (100 × 10 ms) but never steal
              ownership. Live endpoints are never stolen; unverifiable claims stay fail-closed.
              Reads use StringDecoder for chunk-safe UTF-8; each connection gets an
              AbortController wired to close/end/error so orphaned renders cancel; teardown
              removes the socket only when its device and inode still match the one it created.
            </Text>
            <Text size="small" tone="tertiary">
              Source: src/events/ipc.ts — claimEndpoint, reclaimOrphanedEndpointClaim,
              tryAcquireEndpointRecoveryGate, readOneMessage, closeServer.
            </Text>
          </Stack>
        </CollapsibleSection>
      </Stack>

      <Divider />

      {/* ==================================================== event matrix */}
      <Stack gap={12}>
        <H2>5 · Event families × hosts</H2>
        <Text tone="secondary" style={{ maxWidth: 860 }}>
          The v1 vocabulary is seven canonical families. Six are supported on
          all three interactive hosts under their native names;{" "}
          <Text as="span" style={{ fontFamily: MONO }}>workspace/open</Text> is supported on
          Cursor as a fire-and-forget observation (the optional native pluginPaths
          return is deliberately not modeled) and stays unavailable on Claude and
          Codex — with a written reason per host, not a silent gap.
        </Text>
        <Table
          headers={["Canonical event", "Claude 2.1.250", "Codex 0.147.0", "Cursor 2026-08-28", "Portable 1.0.0"]}
          rowTone={["success", "success", "success", "success", "success", "success", "warning"]}
          rows={[
            [<Text as="span" style={{ fontFamily: MONO }} size="small">session/start</Text>, "SessionStart", "SessionStart", "sessionStart", "—"],
            [<Text as="span" style={{ fontFamily: MONO }} size="small">tool/before</Text>, "PreToolUse", "PreToolUse", "preToolUse", "—"],
            [<Text as="span" style={{ fontFamily: MONO }} size="small">tool/after</Text>, "PostToolUse", "PostToolUse", "postToolUse", "—"],
            [<Text as="span" style={{ fontFamily: MONO }} size="small">stop</Text>, "Stop", "Stop", "stop", "—"],
            [<Text as="span" style={{ fontFamily: MONO }} size="small">agent/start</Text>, "SubagentStart", "SubagentStart (adds turn_id, model, permission_mode)", "subagentStart", "—"],
            [<Text as="span" style={{ fontFamily: MONO }} size="small">agent/stop</Text>, "SubagentStop", "SubagentStop", "subagentStop", "—"],
            [<Text as="span" style={{ fontFamily: MONO }} size="small">workspace/open</Text>, "unavailable: no such event", "unavailable: no such event", "workspaceOpen (observe-only; optional pluginPaths return not modeled)", "unavailable: spec defines no hooks"],
          ]}
        />
        <Grid columns="1fr 1fr" gap={12} align="start">
          <Stack gap={8}>
            <H3>What each event may answer</H3>
            <Table
              framed
              headers={["Event", "Deny / block", "updatedInput", "additionalContext"]}
              rows={[
                ["session/start", "—", "—", "all hosts"],
                ["tool/before", "yes, reason required", "yes (when not denying)", "Claude + Codex; dropped on Cursor"],
                ["tool/after", "—", "—", "all hosts"],
                ["stop", "yes — keeps the agent working (Cursor: followup_message)", "—", "—"],
                ["agent/start", "no host can block subagent creation", "—", "all hosts"],
                ["agent/stop", "Claude + Codex (keeps subagent running); Cursor cannot", "—", "Claude + Cursor; Codex schema rejects it"],
                ["workspace/open", "—", "—", "no channel — observation only (Cursor)"],
              ]}
            />
            <Text size="small" tone="tertiary">
              Source: events/projection.ts projectEventDocument and the wrapper validateResult in
              adapters/hook-contract.ts — illegal combinations throw before anything reaches the host.
            </Text>
          </Stack>
          <Stack gap={8}>
            <H3>Canonical tool selectors → native matchers</H3>
            <Table
              framed
              headers={["Selector", "Claude", "Codex", "Cursor"]}
              rows={[
                [<Text as="span" style={{ fontFamily: MONO }} size="small">file.read</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">^Read$</Text>, "—", <Text as="span" style={{ fontFamily: MONO }} size="small">^Read$</Text>],
                [<Text as="span" style={{ fontFamily: MONO }} size="small">file.write</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">^(?:Write|Edit)$</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">^(?:apply_patch|Edit|Write)$</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">^Write$</Text>],
                [<Text as="span" style={{ fontFamily: MONO }} size="small">shell</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">^Bash$</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">^Bash$</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">^Shell$</Text>],
                [<Text as="span" style={{ fontFamily: MONO }} size="small">mcp</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">^mcp__</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">^mcp__</Text>, <Text as="span" style={{ fontFamily: MONO }} size="small">^MCP:</Text>],
                [<Text as="span" style={{ fontFamily: MONO }} size="small">agent</Text>, "—", "—", <Text as="span" style={{ fontFamily: MONO }} size="small">^Task$</Text>],
              ]}
            />
            <Text size="small" tone="secondary">
              A hook can also pin host-scoped native tool names; a selector no target can map is a
              per-target diagnostic, never a silently empty matcher.
            </Text>
          </Stack>
        </Grid>
        <Card>
          <CardHeader trailing={<Pill size="sm">standalone example</Pill>}>
            src/events/tool/after.tsx — a real event route
          </CardHeader>
          <CardBody style={{ padding: 0 }}>
            <MonoBlock text={EVENT_ROUTE_SNIPPET} />
          </CardBody>
        </Card>
      </Stack>

      <Divider />

      {/* ======================================================== MCP flow */}
      <Stack gap={12}>
        <H2>6 · MCP tools: the same architecture, request-shaped</H2>
        <Row gap={6} align="stretch">
          <StageBox title="Host MCP client" detail="tools/call over stdio or streamable HTTP" />
          <FlowArrow />
          <StageBox title="Generated entry" detail="mcp/<server>.mjs — framework stdio lifecycle shell, console guard, bounded shutdown" />
          <FlowArrow />
          <StageBox title="Warm Flight worker" detail="mcp/<server>-flight.mjs — long-lived react-server worker, one per server process" emphasized />
          <FlowArrow />
          <StageBox title="Projection" detail="render-event stream → progress notifications + legal MCP result content" />
        </Row>
        <Text tone="secondary" style={{ maxWidth: 880 }}>
          The generated entry carries the compiled route table as data and hands a warm worker to
          the shared server runtime (createGeneratedRouteMcpServer). Each tools/call validates
          input with the route's real zod schema, renders the async default component inside
          runAgentRequest — with providers, the state kernel, and the notice ledger bound —
          streams Flight bytes back, and projects them onto MCP: progress reports become
          notifications, Agent.Result becomes structured content validated by resultSchema. MCP
          Apps embed their built HTML into the bundle as resources keyed by resourceUri. When the
          bundle has event routes, exactly one generated server also hosts the event runtime IPC
          socket — that is the warm runtime hooks talk to, so hooks share process state with tools.
        </Text>
        <Text size="small" tone="tertiary">
          Source: build/entry-shell.ts (generatedRouteMcpEntrySource, generatedRouteFlightWorkerSource),
          src/mcp-server-runtime.ts (startEventRuntime, projectMcpRenderStream), build/entries.ts.
        </Text>
      </Stack>

      <Divider />

      {/* ==================================================== supporting */}
      <Stack gap={12}>
        <H2>7 · Supporting systems</H2>
        <Grid columns={3} gap={12} align="start">
          <Card>
            <CardHeader>State</CardHeader>
            <CardBody>
              <Stack gap={8}>
                <MonoBlock dim text={STATE_SNIPPET} />
                <Text size="small" tone="secondary">
                  Drivers supply storage for exactly one lifetime — memory for request/process,
                  SQLite under the plugin root's state/ for workspace-durable; external needs
                  embedder wiring and is rejected for generated mounting (AB4820). Budgets
                  (bytes, revisions, commit latency) fail closed with budget-exceeded. Doctor
                  inventories durable stores by filesystem metadata only — it never opens a database.
                </Text>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>Notices</CardHeader>
            <CardBody>
              <Stack gap={8}>
                <Text size="small" tone="secondary">
                  An append-only ledger co-mounted with state (reserved id, AB4821). A notice
                  targets a recipient — the conjunction of observed identity axes — and moves
                  through evidenced states only: pending, attempted, expired, unavailable,
                  withdrawn. Delivery is attempted on the next event render; a recipient-scoped
                  MCP inbox resource (agent-bundle://notices/inbox) exposes pending notices with
                  exposure receipts. No host claims are fabricated.
                </Text>
                <Row gap={6} wrap>
                  <Pill size="sm">pending</Pill>
                  <Pill size="sm">attempted</Pill>
                  <Pill size="sm">expired</Pill>
                  <Pill size="sm">unavailable</Pill>
                  <Pill size="sm">withdrawn</Pill>
                </Row>
              </Stack>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>Context axes</CardHeader>
            <CardBody>
              <Stack gap={8}>
                <Text size="small" tone="secondary">
                  Inside any route, await agent() returns the request context: host, session,
                  actor, and workspace each as an Observed value — either
                  &#123; state: 'available', value, source &#125; or
                  &#123; state: 'unavailable', reason &#125;. Honest absence is the contract: a CLI
                  render reports host unavailable ('unsupported-surface') rather than inventing
                  one. Capabilities (command, filesystem, network, projectRoot) follow the same
                  shape; src/providers/* factories add request-scoped values beside the
                  framework-owned processLifetime.
                </Text>
                <MonoBlock
                  dim
                  text={`const ctx = await agent();
ctx.actor.state === 'available'
  ? ctx.actor.value.id
  : ctx.actor.reason  // e.g. 'not-provided'`}
                />
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      <Divider />

      {/* ======================================================== dev loop */}
      <Stack gap={12}>
        <H2>8 · The dev loop: epochs, Workbench, doctor, install</H2>
        <Text tone="secondary" style={{ maxWidth: 880 }}>
          agent-bundle dev watches the project, serializes rebuilds, and commits each successful
          build as an immutable epoch under .agent-bundle/epochs/&lt;uuid&gt;/ with an
          active-epoch.json pointer — the same epoch identity that fences hook IPC, so a stale
          wrapper can never talk to a newer runtime. A package-build failure never invalidates a
          committed artifact epoch (it surfaces as the AB7103 warning and retries). Generated
          route declarations publish atomically to .agent-bundle/routes.d.ts.
        </Text>
        <Grid columns="1fr 1fr" gap={12} align="start">
          <Stack gap={8}>
            <H3>Workbench (desktop web UI over the dev server)</H3>
            <Table
              framed
              headers={["Page", "What it shows"]}
              rows={[
                ["Overview + Routes", "Compiler-manifest-driven navigation and the compiled route catalog"],
                ["MCP", "Live tool invocation against the dev runtime; session controller; JSON input editors"],
                ["Playground", "Native hook playground and semantic lifecycle replay — replays recorded native envelopes through validateNativeEventEnvelope → render → projection"],
                ["Skills / Evals / Comparisons", "Skill documents, eval runs with persisted stores, artifact comparisons"],
                ["Logs / Artifacts / Hosts", "Dev log streams; emitted artifact inspection; read-only host discovery over the install doctor"],
              ]}
            />
          </Stack>
          <Stack gap={8}>
            <H3>Doctor and install</H3>
            <Text size="small" tone="secondary">
              agent-bundle doctor is strictly read-only (AB7300–AB7316): host CLI probes,
              installed-bundle inventory, bundle-to-source comparison, registration proof, event
              runtime endpoint health, and durable-state inventory. It never repairs anything.
            </Text>
            <MonoBlock
              dim
              text={`agent-bundle install claude --from artifact/claude --scope user
agent-bundle install codex  --from artifact/codex
agent-bundle install cursor --from artifact/cursor   # staged copy`}
            />
            <Text size="small" tone="secondary">
              Every target directory is independently distributable with a generated INSTALL.md;
              cursor/portable/plugin targets also ship a standalone install.mjs whose staged copy
              is idempotent for identical content, refuses version or content collisions, and
              never touches sudo or PATH. The packed proof level (agent-bundle/test) runs the
              same mcp-server-runtime in memory, and deleted-source proofs verify artifacts stay
              self-contained after the source tree is gone.
            </Text>
          </Stack>
        </Grid>
      </Stack>

      <Divider />

      {/* ========================================================== footer */}
      <Stack gap={4}>
        <Text size="small" tone="tertiary">
          Verified against /fast/projects/agent-bundle source: routes/&#123;graph,types,contract,public&#125;.ts ·
          config/validate.ts · adapters/hook-contract.ts + capabilities/*.json ·
          events/&#123;ipc,project,projection&#125;.ts · build/&#123;entries,entry-shell&#125;.ts ·
          mcp-server-runtime.ts · rsc-runtime state/notices/agent-request · docs/diagnostics.md +
          docs/framework-mode.md · examples/&#123;hooks-and-scripts,audiobook-curator,rsc-agent-runtime&#125;.
          Wire payloads in section 4 are illustrative values over verified shapes. Reflects the
          post-PR-#280 split of React rendering (events/project.ts) from envelope projection
          (events/projection.ts). Host capability facts pinned at Claude Code 2.1.250, Codex
          0.147.0, Cursor 2026-08-28, Agent Plugins 1.0.0 (observed 2026-08-28 … 2026-09-01).
        </Text>
        <Text size="small" tone="quaternary">
          Generated 2026-09-01 · colors follow the host theme ({t.kind})
        </Text>
      </Stack>
    </Stack>
  );
}
