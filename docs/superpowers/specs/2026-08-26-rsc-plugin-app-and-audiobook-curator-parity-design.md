# RSC Plugin App Framework and Audiobook Curator Parity

## Goal

Make `@agent-bundle/rsc-runtime` the production-quality authoring layer for a complete Agent Bundle application, then prove it by recreating every supported Audiobook Curator workflow in TypeScript from one RSC-authored definition. One source tree must produce the workspace CLI, the bundled executable, the MCP catalog and handlers, the Skill, and validated Claude and Codex artifacts.

The previous three-operation curator is a useful spike, not the finish line. This design replaces its intentionally narrow scope.

## Product boundary

The framework is the "Next.js for agent plugins" layer above Agent Bundle's compiler:

- Agent Bundle continues to own normalization, target capability validation, artifact compilation, installation, and host-specific Claude/Codex output.
- `@agent-bundle/rsc-runtime` owns a host-neutral application definition, typed operation registry, RSC result rendering, and generic CLI/MCP adapters.
- The curator owns audiobook domain behavior and optional integrations. It does not fork framework code.
- React is an authoring and render model. It does not become a transport, database, process supervisor, or hidden global state owner.

The public framework remains small. It adds a `plugin` export with:

- `defineRscAgentBundle(node)` to lower one declarative plugin tree;
- `AgentBundle`, `Skill`, `Script`, `McpServer`, and `Operation` definition elements;
- a frozen compiled application containing an `AgentBundleConfig` and an operation registry;
- `defineOperation(...)` for one typed implementation shared by CLI and MCP;
- `createRscMcpServer(application)` and `runRscCli(application, argv, options)` adapters;
- strict duplicate-name, finite-data, target, command, and schema validation.

The existing `Hook`, `Mcp`, result lowerers, and request context remain compatible.

## Authoring model

The curator's canonical definition is a TSX module:

```tsx
export const application = defineRscAgentBundle(
  <AgentBundle
    description="Evidence-backed audiobook curation"
    name="audiobook-curator"
    targets={['claude', 'codex']}
    version="1.0.0"
  >
    <Skill source="./skills/curate-audiobooks" />
    <Script entry="./src/cli-entry.ts" name="audiobook-curator" />
    <McpServer entry="./src/mcp-server.ts" name="curator" />
    {audiobookOperations.map((operation) => <Operation definition={operation} key={operation.id} />)}
  </AgentBundle>,
);
```

`agent-bundle.config.ts` exports `application.config`. The MCP entry calls `createRscMcpServer(application)`. The workspace `bin` and bundled script both call `runRscCli(application, argv)`. Nothing manually re-lists commands or tools.

Each operation definition owns:

- a stable operation ID;
- one strict input schema and result/receipt schema;
- one implementation accepting the caller's `AbortSignal` and injected capabilities;
- CLI name, help, positional/flag parser, and exit-status projection;
- optional MCP name, description, annotations, and input exposure;
- an RSC result component lowered to MCP protocol content;
- whether it is read-only, plan-only, or mutation-capable.

CLI-specific paths such as report and receipt destinations remain CLI adapter concerns. Domain handlers return detached receipts; the adapter writes them atomically when requested and also prints the canonical JSON result.

## Audiobook operation parity

The application exposes every behavior supported by the original repository:

1. `inventory` / `inventory_sources`
   - bounded recursive discovery;
   - natural ordering;
   - per-file ffprobe facts and retained probe errors;
   - strict and non-strict outcomes.
2. `library-audit` / `audit_library`
   - bounded parallel inspection;
   - missing metadata, artwork, chapter, duplicate, multipart, and probe findings;
   - no deletion instructions.
3. `select` / `select_sources`
   - collision keys that preserve part numbers;
   - lossless, bit-depth, sample-rate, and bitrate quality ordering;
   - duration-spread review gates.
4. `convert` / `convert_audiobook`
   - dry-run by default and explicit apply;
   - single-file M4B stream copy when valid;
   - multipart FFmpeg conversion;
   - optional Audiobook Forge engine;
   - AAC and ALAC output;
   - safe channel/sample-rate/layout/bit-depth validation;
   - deterministic chapters, bounded parallel segment preparation, staged verification, and atomic publication;
   - immutable source files.
5. `audible-search` / `search_audible`
   - all original regions;
   - normalized candidate evidence and scoring for title, author, narrator, language, abridgement, and duration;
   - retained per-region failures;
   - no automatic acceptance.
6. `audible-select` / `select_audible_edition`
   - explicit human candidate selection and note-backed receipt.
7. `audible-cache` / `cache_audible_edition`
   - product, chapter, source URL, and available cover caching;
   - bounded downloads and atomic cache publication.
8. `apply-metadata` / `apply_audiobook_metadata`
   - normalized product metadata and optional user overrides;
   - artwork support;
   - stream-copy staging;
   - audio, chapter, duration, language, stream, and metadata verification before atomic replacement.
9. `apply-chapters` / `apply_audiobook_chapters`
   - generic and Audible chapter inputs;
   - continuity/bounds/title validation;
   - stream-copy staging and complete post-write verification.
10. `acoustic-verify` / `verify_audible_sample`
    - optional Audiolocate adapter;
    - Audible sample acquisition;
    - positive evidence without automatic edition acceptance.
11. `acoustic-identify` / `identify_audible_sample`
    - candidate deduplication, ordered attempts, configurable top/all selection, and review-required no-match result.
12. `whisper-verify` / `verify_with_whisper`
    - distributed sampling windows;
    - ffmpeg PCM extraction;
    - optional `whisper-cli` adapter;
    - usable transcript thresholds and inconclusive review outcomes.
13. `audit` / `audit_audiobook`
    - SHA-256, per-audio-stream hashes, ffprobe facts, chapters and expected source mapping;
    - optional full decode;
    - structural and continuity findings.

The CLI preserves the original command names, significant options, and exit meanings: `0` completed, `1` operational/validation failure, and `2` review required or inconclusive. It also provides root and per-command `--help`.

## Receipts and data contracts

All receipts use a strict unversioned canonical document for this pre-release example:

- `generatedAt`, `operation`, and `mutation` are always present;
- results are detached finite JSON;
- report/receipt output may not collide with an input or media extension;
- receipt writes are staged, synced, and atomically published without overwrite unless the operation explicitly supports replacement;
- path values are bounded and may not leak unrelated filesystem or credential material through MCP summaries;
- operational failures keep their root cause locally while user-facing messages remain safe.

The implementation ports the original receipt fields before adding framework metadata. Tests compare required fields and semantic behavior rather than Python serialization accidents.

## External capabilities

The bundle owns orchestration and validation. It invokes foreign capabilities only where they provide the underlying media or recognition primitive:

- required: `ffprobe` and `ffmpeg`;
- optional: Audiobook Forge CLI;
- optional: Python Audiolocate import/runner;
- optional: `whisper-cli` and its selected model;
- network: Audible public product/search/sample endpoints through an injected HTTP client.

Capabilities are explicit, injectable, and probed at the operation boundary. Missing optional tools produce actionable unsupported/inconclusive receipts, never a silent fallback with different semantics. Child processes use argv arrays with no shell. The inherited environment is allowlisted. Output is byte-bounded. Cancellation is owned by the caller's `AbortSignal`.

Per the product direction, local media and recognition operations have no internal wall-clock deadline. Network retries remain bounded by attempt count, byte count, and caller cancellation; no hidden global timer ends a long-running media job.

## Safety model

- Discovery never follows symlinked media or directories.
- Inputs must be regular files and are revalidated through opened descriptors where bytes are authoritative.
- Conversion never overwrites or removes source media.
- Mutations are dry-run unless `apply: true` is explicit.
- In-place metadata/chapter changes stage beside the destination, verify audio identity and structural invariants, preserve metadata where promised, then atomically replace.
- New outputs stage in curator-owned directories and publish without overwrite unless `overwrite` is explicit.
- Mixed or unsupported stream properties fail before expensive conversion.
- Audible candidates always require human selection.
- Acoustic and transcript evidence can support selection but cannot silently select an edition.
- ZeroFS acceptance treats `/mnt/zerofs-files/JBOD-Offload/Audiobooks` as immutable. Derived outputs and receipts go to test-owned local storage.

## Skills and host output

The native Markdown Skill remains the correct host format. It documents the complete evidence-gated workflow, tool choice, approval boundaries, optional capability setup, and receipt interpretation. No hook is required: the curator acts only when invoked.

One Agent Bundle build must produce both Claude and Codex artifacts containing:

- the same Skill;
- the complete stdio MCP server;
- the bundled CLI script;
- target-native MCP registration and plugin metadata;
- no credentials, media, models, caches, or machine paths.

## Verification and parity ledger

The old repository is the behavior oracle. Its CLI, tests, README, Skill, command, and reference documents are converted into a checked parity ledger. Completion requires evidence for every row.

Automated acceptance includes:

- public RSC plugin-app definition and invalid-tree tests;
- CLI/MCP catalog identity tests proving no operation drift;
- ported unit tests for scoring, selection, receipts, chapter parsing, filenames, and result statuses;
- synthetic ffprobe/ffmpeg/Audiobook Forge/Audiolocate/Whisper/network adapter tests;
- real ffmpeg fixture workflows for stream copy, AAC, ALAC, multipart chapters, metadata, artwork, and chapter repair;
- build and validate for Claude and Codex;
- installed isolated-host MCP catalog and representative invocation tests;
- root typecheck/lint/repository gates in proportion to the change.

Real-world acceptance includes:

- read-only ZeroFS inventory, library audit, selection, and integrity audit;
- an approved derived-output conversion into local scratch storage followed by metadata/chapter/audit verification;
- Audible discovery/cache only if network access is available and no credentials are required;
- optional Audiolocate/Whisper runs when their external dependencies are installed, with explicit unsupported evidence otherwise.

## Release and repository shape

- `packages/rsc-runtime` stays an ordinary publishable workspace package.
- `examples/audiobook-curator` stays a public example and workspace package.
- Changesets cover publishable packages; pkg.pr.new remains the canary path.
- No tarball-only development workflow or custom monorepo orchestrator is added.
- Commits are incremental by framework, domain slice, host output, and acceptance evidence.

## Non-goals

- Reimplementing codecs, speech recognition, or acoustic fingerprinting.
- Automatically choosing an Audible edition without review.
- Shipping media, cached Audible payloads, credentials, Whisper models, or Python environments.
- Adding hooks without a concrete curator lifecycle need.
- Building a filesystem router or general web framework when a declarative application tree and shared operation registry suffice.
