# agent-bundle

Compile a typed Agent Bundle configuration into portable, Codex, and Claude Code artifacts. Node.js 22.19 or later is required.

```sh
npm install --save-dev agent-bundle
agent-bundle dev --root .
agent-bundle build --root . --output artifact
```

The package supports source `inspect`, source or artifact `validate`, local artifact MCP list/invoke, artifact hook list/simulate, and ordinary local development:

```sh
agent-bundle dev --root .
```

`inspect` reads source configuration; use `validate --artifact artifact` for source-free artifact validation. `dev.runtime.provider` is an advanced optional extension: a normal project starts the dev server and Workbench without loading an RSC provider.

## Commands

| Command | Purpose |
| --- | --- |
| `agent-bundle build` | Build a validated artifact from source. |
| `agent-bundle validate` | Validate project source, or an artifact with `--artifact`. |
| `agent-bundle inspect` | Inspect normalized targets and adapter plans from source. |
| `agent-bundle mcp list` / `mcp invoke` | List or invoke one MCP tool from an artifact. |
| `agent-bundle hooks list` / `hooks simulate` | List generated hooks, or run one emitted wrapper. |
| `agent-bundle eval` | Run deterministic or native Claude/Codex eval suites and record a run. |
| `agent-bundle dev` | Serve the packaged developer workbench on loopback. |

`validate --artifact`, `mcp`, and `hooks` work against a built artifact with project sources deleted.

## Developer workbench

`agent-bundle dev` serves a loopback-only prebuilt workbench with project diagnostics and Skills,
artifact provenance, artifact-bound MCP and hook playgrounds, durable ordered playground traces, and
eval runs and comparisons. Hook and MCP operations can record into an open playground trace for export
or promotion into a draft eval case.

## Evaluation

Eval suites are typed modules discovered by convention:

```ts
import { defineEvalSuite, expectExitCode } from 'agent-bundle/eval';
```

Assertions resolve to `pass`, `fail`, or `inconclusive`; insufficient evidence is never silently
passed. Fewer than three trials is smoke evidence, and comparisons label unrecorded alignment facets
as unverified.

An optional semantic grader is configured with one pinned Claude model:

```ts
evals: {
  semanticGrader: { harness: 'claude', model: 'claude-sonnet-4-5' },
}
```

It runs only with `agent-bundle eval --harness claude` for Claude-pinned cases. After the primary
trace is usable and deterministic graders finish, Agent Bundle makes one server-owned, plugin-free
Claude grading call. Its fixed result id is `claude-semantic`; its request, raw stream, stderr, and
versioned provenance are retained with the trial artifacts. A malformed or failed semantic grader
leaves the trial inconclusive rather than becoming plugin evidence.

## Authentication and limitations

This package never accepts, requests, injects, or persists a model-provider API key. Native Claude and
Codex harnesses use an already installed signed-in CLI after provider-key environment variables are
removed. Native smoke tests are opt-in; Codex Skill-activation evidence is inferred, not observed.
Semantic model-backed grading/configuration is explicitly refused, and raw HTML, JSX/MDX, and Mermaid
in Skill Markdown are inert in the workbench renderer.

Top-level `scripts` is a record of stable output names to an entry path or `{ entry, targets? }`. JavaScript/TypeScript entries bundle to `scripts/<name>.mjs`; `.sh`, `.bash`, and `.py` entries copy byte-for-byte while preserving source modes. The generated `agent-bundle.manifest.json` records file digests for stable artifact validation.

`AgentBundleConfig` merges bundled portable, Codex, and Claude declarations
through `AgentBundleConfigExtensions`. `TargetRegistry` owns the unique
extension descriptor and adapter for each target. Ordinary projects need no
extension key; extension values are strict finite JSON and host-specific values
stay in their adapter. Add a host by registering an adapter and exporting/merging
its interface instead of adding raw compiler or Runtime parsing. ChatGPT/OpenAI
and Claude Workbench simulation profiles are not configuration-extension claims.

The package publishes no example RSC provider, host credentials, or native-host
evaluation integration. See the repository's
[optional RSC Runtime topology](../../docs/architecture/rsc-runtime-workbench.md)
for the explicit example-owned boundary.

- The workbench binds to loopback only and is a foreground development session, not a hosted service.
- Native Claude and Codex harnesses require those CLIs to be installed and signed in. A missing,
  incompatible, or unauthenticated CLI is reported as a harness failure, distinct from a plugin
  failure. Their live smoke tests are opt-in and are not part of an ordinary test run.
- Codex exposes no authoritative Skill-activation event, so Codex activation evidence is `inferred`
  and is never reported as `observed`.
- Comparison facets that a run did not record — grader versions, host CLI version, invocation — are
  labeled unverified rather than assumed aligned.
- Semantic grading requires a native Claude harness and a signed-in Claude Code session; deterministic
  and Codex selections are refused when it is configured.
- Raw HTML, JSX/MDX, and Mermaid in Skill Markdown are inert in the workbench renderer.

Third-party notices, including the vendored MCP Inspector snapshot's license and provenance, ship in
the published package.
