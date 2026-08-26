# Audiobook Curator

A complete TypeScript recreation of the original `audiobook-curator`, authored
as one React Server Component plugin application. The same typed operation tree
produces a globally installable CLI, one stdio MCP server, one Skill, and native
Claude Code and Codex plugin artifacts. It has no hooks and does not call the old
Python curator.

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
pnpm --filter @agent-bundle-example/audiobook-curator build:cli
cd examples/audiobook-curator
ln -s "$(pwd)/bin/audiobook-curator.js" ~/.local/bin/audiobook-curator
audiobook-curator --help
```

Choose any writable directory already on `PATH` in place of `~/.local/bin`.
This is a direct workspace link; it does not pack or install a tarball.

`build:bundle` writes complete Claude and Codex outputs beneath `artifact/`,
including each host's plugin metadata, Skill, bundled CLI script, and bundled MCP
server. The example uses only public `agent-bundle` and
`@agent-bundle/rsc-runtime` exports with `workspace:*` dependencies.

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
