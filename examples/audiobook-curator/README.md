# Audiobook Curator

From the repository root, launch this example with:

```bash
pnpm example:audiobook
```

A complete TypeScript recreation of the original `audiobook-curator`, built in
framework mode: `agent-bundle.config.ts` plus file conventions declare the
structure, and one typed operation catalog produces a globally installable
CLI, one stdio MCP server, one Skill, and native Claude Code and Codex plugin
artifacts. JSX appears only where something is rendered — the MCP result
receipts. It has no hooks and does not call the old Python curator.

The package requires Node 22.19+, `ffprobe`, and `ffmpeg`. Optional features call
the foreign tools that actually provide the evidence: Audiobook Forge,
Audiolocate in a selected Python environment, and `whisper-cli` with a selected
model. Local media processes have no wall-clock deadline; caller cancellation
and bounded stdout/stderr remain enforced.

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

One `agent-bundle build` produces everything: complete Claude and Codex
outputs beneath `artifact/` (each host's plugin metadata, Skill, bundled CLI
script, and lifecycle-wrapped MCP server) plus the npm package build beneath
`dist/` (`dist/bin/audiobook-curator.js` for `package.json` `bin`,
`dist/index.js` and declarations for `exports`). The example uses only public
`agent-bundle` and `@agent-bundle/runtime` exports with `workspace:*`
dependencies.

## Operation model

Every command is one `defineOperation` definition: a host-neutral use case —
`id`, input schema, `execute`, result schema, `render` — with two
projections declared beside it. The shared core runs identically on both
surfaces (`inputSchema.parse` → `execute` → `resultSchema.parse`); `cli`
adds argv parsing and exit codes, and `mcp` adds tool metadata. `render` is
a sibling of both, required on every operation but consumed only by the MCP
projection: the CLI prints each validated receipt as one line of JSON and
never renders JSX.

The runtime JSX for every operation is `<CuratorResult>` in
[`src/result.tsx`](src/result.tsx), which wraps the receipt in the MCP
result DSL:

```tsx
export const CuratorResult = ({ receipt }: { readonly receipt: CuratorReceipt }) => (
  <Mcp.Result structuredContent={receipt}>
    <Mcp.Text>{summary(receipt)}</Mcp.Text>
  </Mcp.Result>
);
```

`lowerMcpResult` lowers that element tree synchronously into an MCP
`CallToolResult`. No React Server Components renderer or Flight transport is
involved anywhere in this example; operation modules are `.tsx` only because
`render` returns JSX, and `src/application.ts` stays `.ts` because it merely
composes the operation arrays. The end-to-end walkthrough is in
[Framework mode](../../docs/framework-mode.md).

## Source layout

- `agent-bundle.config.ts` — the structure: plugin identity, targets, the CLI
  script, and the MCP server (whose entry is the `src/mcp/curator.ts`
  convention). The Skill needs no declaration at all:
  `skills/curate-audiobooks/SKILL.md` ships by convention.
- `src/application.ts` — composition only: merges the feature modules'
  defaults into one `defineRscApplication` operation catalog.
- `src/operations/` — the operation catalog, grouped by workflow stage:
  `discovery` (inspect/inventory/library-audit/select), `audible`
  (search/select/cache), `evidence` (acoustic/whisper), `media-mutation`
  (apply-metadata/apply-chapters), and `output` (convert/prepare/audit), with
  shared `cli-arguments.ts` and `schemas.ts`.
- Domain logic lives beside them in `src/` (`library.ts`, `audible.ts`,
  `evidence.ts`, `conversion.ts`, `media-mutation.ts`, `integrity-audit.ts`,
  `curator-core.ts`) over the shared `foundation.ts` and `media-process.ts`
  primitives; `result.tsx` renders every receipt for MCP.
- `src/cli.ts` exports `main`; the framework's generated process envelope
  turns it into both the bundled script artifact entry and the npm bin.
  `src/mcp/curator.ts` default-exports a server factory served under the
  framework's stdio lifecycle shell. No hand-written entry shims remain.

## Complete workflow

The original thirteen commands are present:

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

`inspect` and `prepare` remain as small supplemental local operations. Every
operation also has an MCP tool with the same implementation and result renderer;
run `audiobook-curator --help` for exact CLI forms.

## Run the MCP server

From this example's directory, run the built `curator` server in the
foreground on stdio:

```bash
cd examples/audiobook-curator
pnpm exec agent-bundle mcp run --server curator --target claude
```

The command resolves the generated entry from the Claude target's MCP
manifest, building a temporary artifact first; pass `--artifact artifact` to
reuse the `pnpm build` output instead. Closing stdin exits 0 and Ctrl-C
exits 130, and per-server state persists under
`.agent-bundle/mcp-run/claude/curator`.

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

This example is the reference consumer of the framework-owned package build
("one config, agent-bundle owns the build"): `agent-bundle.config.ts` declares
the structure directly, and the `src/cli.ts` / `src/index.ts` conventions
provide the npm bin and library outputs under `dist/`. See
[`docs/entry-conventions.md`](../../docs/entry-conventions.md)
for the contract.
