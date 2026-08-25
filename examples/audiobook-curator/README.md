# Audiobook Curator

A self-contained TypeScript Agent Bundle example for Claude Code and Codex. It
ships one Skill, one MCP server with three RSC-rendered tools, and a globally
installable `audiobook-curator` CLI backed by the same core.

The product requires Node 22.19+, `ffprobe`, and `ffmpeg`. It does not use the
older Python curator or any globally installed wrapper.

## Workspace use

```sh
pnpm install
pnpm --filter @agent-bundle-example/audiobook-curator check
pnpm --filter @agent-bundle-example/audiobook-curator dev
```

The build writes Claude and Codex plugin artifacts beneath `dist/`. There are no
hooks.

## CLI

Build and install directly from the workspace package:

```sh
pnpm --filter @agent-bundle-example/audiobook-curator build:cli
npm install --global ./examples/audiobook-curator

audiobook-curator inspect /path/to/audiobooks
audiobook-curator prepare /path/to/book.mp3 --output /path/to/curated
audiobook-curator audit /path/to/curated/book.m4b --full-decode
```

`prepare` only reports a plan unless `--apply` is present. Applied conversion
writes and probes a temporary M4B, then promotes it to a new file in a separate
output directory. It never overwrites, renames, or deletes source media.

## MCP tools

- `inspect_sources`: bounded recursive inventory with ffprobe metadata.
- `prepare_audiobook`: plan-first M4B conversion with typed explicit apply.
- `audit_audiobook`: ffprobe, streaming SHA-256, and optional full decode.

Audible lookup, Whisper, and acoustic matching are intentionally later
extensions rather than prerequisites for the useful local workflow.
