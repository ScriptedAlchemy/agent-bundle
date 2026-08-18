# agent-bundle

Compile a typed Agent Bundle configuration into portable, Codex, and Claude Code artifacts. Node.js 22.19 or later is required.

```sh
npm install --save-dev agent-bundle
agent-bundle build --root . --output artifact
```

Top-level `scripts` is a record of stable output names to an entry path or `{ entry, targets? }`. JavaScript/TypeScript entries bundle to `scripts/<name>.mjs`; `.sh`, `.bash`, and `.py` entries copy byte-for-byte while preserving source modes. The generated `agent-bundle.manifest.json` records file digests for stable artifact validation.

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

`inspect` reads source configuration. `validate --artifact`, `mcp`, and `hooks` are source-free: they
work against a built artifact with the project sources deleted.

## Developer workbench

`agent-bundle dev` serves a prebuilt workbench on loopback only. It shows project overview and
diagnostics, Skill documents, artifact tree and provenance with epoch comparison, an artifact-bound
MCP playground with the raw protocol trace, a hook playground that runs the emitted wrapper, a
durable ordered playground trace with replay and export, and eval runs and comparisons.

Hook and MCP operations record into the playground trace when a playground session is open, so one
ordered trace can be exported or promoted into a draft eval case.

## Evaluation

Eval suites are typed modules discovered by convention:

```ts
import { defineEvalSuite, expectExitCode } from 'agent-bundle/eval';
```

Every assertion resolves to `pass`, `fail`, or `inconclusive`, and declares the minimum evidence it
accepts. An assertion that needs stronger evidence than the harness produced is inconclusive, never
silently passed. Fewer than three trials is reported as smoke evidence rather than a reliability
number, and comparison rows are only aligned when case, fixture, grader versions, harness, host CLI
version, invocation, and model all match.

## Authentication

This package never accepts, requests, injects, or persists a model-provider API key, and there is no
configuration field for one. The native Claude and Codex harnesses run the CLI already installed on
your machine and rely on its existing signed-in subscription/session; provider API-key environment
variables are removed from the child environment before that CLI is launched.

## Limitations

- The workbench binds to loopback only and is a foreground development session, not a hosted service.
- Native Claude and Codex harnesses require those CLIs to be installed and signed in. A missing,
  incompatible, or unauthenticated CLI is reported as a harness failure, distinct from a plugin
  failure. Their live smoke tests are opt-in and are not part of an ordinary test run.
- Codex exposes no authoritative Skill-activation event, so Codex activation evidence is `inferred`
  and is never reported as `observed`.
- Comparison facets that a run did not record — grader versions, host CLI version, invocation — are
  labeled unverified rather than assumed aligned.
- Semantic (model-backed) grading and model-backed eval configuration are refused with an explicit
  diagnostic rather than silently skipped.
- Raw HTML, JSX/MDX, and Mermaid in Skill Markdown are inert in the workbench renderer.

Third-party notices, including the vendored MCP Inspector snapshot's license and provenance, ship in
the published package.
