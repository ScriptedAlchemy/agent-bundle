# Audiobook Curator

This example is a complete TypeScript recreation of the original
`audiobook-curator` and a worked tour of an agent-bundle application assembled
from React Server Components, request context, durable state, MCP routes, and
CLI routes. It produces one generated stdio MCP server, an installable CLI, one
Skill, and native Claude Code and Codex plugin artifacts. It has no hooks and
does not call the old Python curator.

From the repository root, launch the Workbench with:

```bash
pnpm example:audiobook
```

The package requires Node 22.19+, `ffprobe`, and `ffmpeg`. Optional features call
the foreign tools that provide their evidence: Audiobook Forge, Audiolocate in
a selected Python environment, and `whisper-cli` with a selected model. Local
media processes have no wall-clock deadline; caller cancellation and bounded
stdout/stderr remain enforced.

## Workspace use

```sh
pnpm install
pnpm --filter @agent-bundle-example/audiobook-curator test
pnpm --filter @agent-bundle-example/audiobook-curator typecheck
pnpm --filter @agent-bundle-example/audiobook-curator build
```

Build and globally link the workspace package without a tarball:

```sh
pnpm --filter @agent-bundle-example/audiobook-curator build
cd examples/audiobook-curator
ln -s "$(pwd)/dist/bin/audiobook-curator.js" ~/.local/bin/audiobook-curator
audiobook-curator --help
```

Choose any writable directory already on `PATH` in place of `~/.local/bin`.
This is a direct workspace link; it does not pack or install a tarball.

One `agent-bundle build` produces everything: complete Claude and Codex outputs
beneath `artifact/` (each host's plugin metadata, Skill, bundled CLI script, and
lifecycle-wrapped MCP server) plus the npm package beneath `dist/`
(`dist/bin/audiobook-curator.js` for `package.json` `bin`, and `dist/index.js`
plus declarations for `exports`). The example uses only public `agent-bundle`
and `@agent-bundle/runtime` exports with `workspace:*` dependencies.

## Application tour

### The route tree is the application

`agent-bundle.config.ts` declares the plugin identity, Node runtime, Claude and
Codex targets, and MCP-to-CLI projection. File conventions discover the rest.
The MCP tree under `src/mcp/curator/` contains 16 tool routes, one catalog
resource, and one curation prompt. Each executable route exports static
`config`, `inputSchema`, and `resultSchema` values plus an async default Server
Component. The compiler derives the `curator` server, lifecycle entry, warm
Flight worker, and MCP registrations; there is no `src/application.ts`,
operation-array registry, handwritten `src/mcp/curator.ts`, or per-operation
server selector.

The routed CLI under `src/cli/` contains 16 authored commands. The
`routes.mcpCommands` setting projects all 16 MCP tools as
`audiobook-curator curator <tool>`, giving the compiled graph 32 CLI commands.
Projected tools accept one optional `--input '<JSON object>'`; tools annotated
read-only run directly, while mutation-capable tools require `--yes`.

### `src/components/` is the shared presentation library

The route modules perform domain work and compose these report components
instead of maintaining separate MCP and CLI presenters:

| Component | MCP composition | Rendered authored CLI composition |
| --- | --- | --- |
| `CuratorDocument` and its `CuratorReceipt` union | Wrap the structured receipt and headline for 15 receipt-bearing tools | Wrap `inventory`, `select`, `audible-search`, `convert`, `audit`, and `library-audit` |
| `DataList`, `Field`, and `Callout` | Provide report primitives throughout the component library and directly in the catalog resource, curate prompt, cache route, and library audit | Provide the same primitives through the shared components and directly in `library-audit` |
| `AudiobookCard` | Renders files in `audit_library` and under shelf and ranking views | Reached through `LibraryShelf` and `CandidateRanking` |
| `LibraryShelf` | Composes `inventory_sources`, `inspect_sources`, and `select_sources` | Composes `inventory` and `select` |
| `CandidateRanking` | Composes `search_audible`, `select_audible_edition`, and `identify_audible_sample` | Composes `audible-search` |
| `EvidenceTrail` | Composes acoustic identification, acoustic verification, and Whisper verification | No authored rendered counterpart; those compatibility commands remain plain `.ts` routes |
| `MutationReceipt` | Composes prepare, conversion, metadata, and chapter mutation tools | Composes `convert` |
| `ChapterOutline` | Composes integrity audit, conversion, and chapter application tools | Composes `audit` and `convert` |
| `IntegrityReport` | Composes integrity audit, conversion, metadata, and chapter application tools | Composes `audit` and `convert` |
| `CurationShelf` | Composes shelf review, Audible edition selection, and metadata/chapter application | Composes `shelf` |
| `LibraryAnalysis` | Resolves the asynchronous duplicate and multipart analysis in `audit_library` | Resolves the same analysis in `library-audit` |

The catalog resource at `src/mcp/curator/resources/catalog.tsx` and the prompt at
`src/mcp/curator/prompts/curate.tsx` are compositions too: both return their
protocol result through `Agent.Result` and use the same report primitives as
the tools.

### `src/providers/library.ts` supplies request context

The conventional `library` provider probes `ffmpeg -version` and
`ffprobe -version` concurrently for each request and publishes the probe time,
tool availability and versions, and the `discover → identify → curate → verify`
workflow stages. The catalog resource reads
`(await agent()).providers.library`, validates the value, and renders either the
live request context or an explicit unavailable state. Tool availability is
therefore observed at request time rather than assumed during the build.

### `src/state.ts` mounts the durable curation shelf

The conventional state module defines the workspace-durable
`audiobook-curator/shelf` state and three events: `editionSelected`,
`mutationApplied`, and `shelfCleared`. `select_audible_edition` dispatches the
selection event; `apply_audiobook_metadata` and `apply_audiobook_chapters`
dispatch mutation records and render the updated shelf. The read-only
`review_curation_shelf` MCP tool and rendered `shelf` CLI command expose the
same mounted state. If state is not mounted, both surfaces return an empty
structured shelf and render an explicit unavailable notice.

### Suspense becomes MCP progress

`audit_library` first reports progress through the request's
`context.progress`, then places the asynchronous `LibraryAnalysis` component
behind React `Suspense`. While that component re-stats duplicate candidates and
calculates reclaimable bytes, its fallback is an `Agent.Progress` document
node. The generated MCP projector streams the progress state and then replaces
it with the completed analysis without changing the final structured
`LibraryAuditReceipt`. The rendered `library-audit` CLI route composes the same
analysis and fallback.

### CLI routes have rendered and plain modes

Seven authored `.tsx` commands render Agent Documents:
`inventory`, `select`, `audible-search`, `convert`, `audit`, `library-audit`,
and `shelf`. Interactive terminals can update reported progress in place;
piped output is one final Markdown document. Nine compatibility commands remain
plain `.ts` routes: `acoustic-identify`, `acoustic-verify`, `apply-chapters`,
`apply-metadata`, `audible-cache`, `audible-select`, `inspect`, `prepare`, and
`whisper-verify`.

The 16 projected MCP commands render the same tool components as their MCP
counterparts. Across plain and rendered commands, `--json` selects machine
output and emits one result-schema-validated JSON value followed by a newline.
For rendered commands that value is the canonical final `Agent.Result` value,
not the Markdown presentation or an intermediate Suspense fallback, so existing
receipt consumers do not change when a command becomes rendered.

`src/operations/` owns shared operation handlers and schemas;
`src/cli-command.ts` defines their small typed definition helper. Domain logic
remains in `src/` over `foundation.ts` and `media-process.ts`, while
`src/index.ts` remains the package library entry.

## Complete workflow

- `inventory`, `library-audit`, and `select` retain probe failures, duplicate and
  multipart evidence, and reviewed source-quality decisions.
- `convert` plans by default and explicitly applies FFmpeg or optional Audiobook
  Forge conversion. It supports AAC and ALAC, natural chapters, parallel segment
  work, single-M4B stream copy, staged verification, and atomic publication.
- `audible-search`, `audible-select`, and `audible-cache` preserve the original
  ten-region ranking formula, require a human edition choice, and retain product,
  chapter, artwork, URL, and regional-error evidence.
- `apply-metadata` and `apply-chapters` plan by default, stream-copy audio, verify
  every encoded audio stream plus chapter/stream invariants, and atomically
  replace only the explicitly selected derived media.
- `acoustic-verify` and `acoustic-identify` use an optional Audiolocate Python
  environment, retaining candidate skips/errors and requiring human edition
  acceptance even after a same-recording match.
- `whisper-verify` extracts distributed mono 16 kHz PCM windows and invokes an
  explicit `whisper-cli`/model for human language, story, and narrator review.
- `audit` records probe facts, chapter defects, source chapter mapping, file and
  encoded-audio hashes, and optional full-decode evidence.

`inspect` and `prepare` remain small supplemental local operations. `shelf`
reviews the durable curation state. Every domain operation also has an MCP tool
with the same implementation; run `audiobook-curator --help` for exact CLI
forms.

## Run the MCP server

From this example's directory, run the built `curator` server in the foreground
on stdio:

```bash
cd examples/audiobook-curator
pnpm exec agent-bundle mcp run --server curator --target claude
```

The command resolves the generated entry from the Claude target's MCP manifest,
building a temporary artifact first; pass `--artifact artifact` to reuse the
`pnpm build` output instead. Closing stdin exits 0 and Ctrl-C exits 130, and
per-server state persists under `.agent-bundle/mcp-run/claude/curator`.

## Safety

Sources are immutable. Planning never mutates media. Conversion publishes a
separate destination; metadata and chapter replacement require explicit
`apply`, use a same-directory staging file, verify the staged result, and then
rename atomically. JSON receipts refuse audio suffixes and collisions with media
or evidence inputs. Network bodies, process output, traversal, and concurrency
are bounded; network work uses bounded attempts and the caller's cancellation
signal rather than hidden deadlines.

The completion contract and real-volume checklist are in
[`docs/parity-ledger.md`](docs/parity-ledger.md).

## Maintainer notes

This example is the reference consumer of the framework-owned package build:
one `agent-bundle.config.ts` declares the structure, conventional
`src/mcp/**`, `src/cli/**`, `src/providers/**`, and `src/state.ts` modules supply
the application surfaces, and agent-bundle owns the generated package and host
artifacts. See [`docs/entry-conventions.md`](../../docs/entry-conventions.md)
for the contract.
