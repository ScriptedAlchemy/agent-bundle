# Amp native adapter proof — 2026-09-07

## Pins and boundary

- `@ampcode/plugin@0.0.0-20260907001852-gf348fed`
- `@ampcode/cli@0.0.1788739286-gf348fe`
- Official Plugin, PluginAPI, Skills, and MCP pages retrieved 2026-09-07
- No Amp account was available. Live thread, model, and tool execution was not run and remains
  **unverified**, not unsupported.

Everything below ran under `/tmp/agent-bundle-amp-proof` with
`HOME=/tmp/agent-bundle-amp-proof/home`.

## Build and static artifact proof

The disposable consumer installed the two pinned Amp packages, TypeScript, Node/Bun type
declarations, and the locally built `agent-bundle` package. npm 12 blocked the CLI postinstall by
default, so the proof completed the package's own `node node_modules/@ampcode/cli/install.cjs`
before invoking Amp.

`agent-bundle build --target amp` emitted:

```text
artifact/
├── .amp/plugins/amp-proof/index.js
├── .amp/plugins/amp-proof/skills/review/SKILL.md
├── INSTALL.md
├── agent-bundle.compile-evidence.json
└── agent-bundle.manifest.json
```

The manifest recorded `manifestVersion: 4`,
`builtInHost: "amp"`, `documents.entry: ".amp/plugins/amp-proof/index.js"`,
adapter revision `1.0.0`, and the pinned PluginAPI version. The compile evidence used
`closed-world-externals` revision 1 and recorded no compiled assets for the content-only plugin.

## PluginAPI type and fake-host proof

Two generated entries were checked with TypeScript 7.0.2 in strict `checkJs` mode:

1. the content-only factory with one explicit `registerSkill`;
2. a callback factory containing inline handlers for `session.start`, `tool.call`, `tool.result`,
   `agent.start`, and `agent.end`.

The disposable `tsconfig.json` alone used `skipLibCheck: true`, because the pinned upstream
declaration references `Symbol.observable`, which the selected TypeScript libs do not declare.
No repository compiler setting was weakened.

Both entries passed. Neither has a runtime `@ampcode/plugin` import; its only reference is the
JSDoc type on the default async factory. A typed fake `PluginAPI` then imported the factories and
asserted:

- exactly `registerSkill({ path: "skills/review" })`;
- no event registrations for the content-only entry;
- exactly the five documented event registrations for the callback entry;
- `tool.call` native results preserved as `reject-and-continue`, `modify`, and `synthesize`;
- `tool.result` replacement preserved as `{ status: "done", output: "replaced" }`.

The repository adapter tests additionally cover `allow`, `agent.start` appended context,
`agent.end` continuation, generated wrapper execution, MCP/frontmatter precedence, relocation,
and receipt-owned install/replace/uninstall.

## Account-free CLI observations

- `amp --help`: exit 0; lists `plugins`, `skill`, and `mcp`.
- `amp skill add --help`: exit 0; source is `owner/repo[/path]`, a Git URL, or a local path;
  `--global` targets `~/.config/agents/skills/`.
- `amp plugins list`: exit 1:

  ```text
  Error: failed to load global plugins. Unable to connect to https://ampcode.com/.
  ```

- `amp skills list --json`: started the login flow with `No API key found. Starting login flow...`
  and was terminated rather than opening or completing an account login.

Amp documents `plugins: reload` only as an interactive command-palette action. No standalone
plugin validator exists, so the implementation does not invent or automate either operation.
