# RSC Runtime Package and Audiobook Curator Example

## Goal

Publish the proven JSX-to-agent-protocol primitives as `@agent-bundle/rsc-runtime`, then prove the package with a user-facing Audiobook Curator Agent Bundle for Claude Code and Codex. Keep the package small, host-neutral, and independent of the existing RSC demo's provider, storage, and packaging implementation.

## Package boundary

`packages/rsc-runtime` is an independently buildable and publishable ESM package for Node 22. It exports:

- `Hook` and `Mcp` JSX elements;
- `lowerHookResult` and `lowerMcpResult` strict lowerers;
- a generic request-context factory for request-scoped RSC values.

React is a peer dependency. MCP protocol types are a direct dependency. Demo-specific edit events, JSONL persistence, provider lifecycle, Workbench integration, and native host packaging remain in `examples/rsc-agent-runtime`.

The existing RSC example must consume the workspace package rather than duplicate these primitives. Release verification must pack the package, install it in an isolated consumer, import every public entry point, and reject undeclared files or private source imports.

## Audiobook Curator example

`examples/audiobook-curator` is a public, self-contained TypeScript Agent Bundle example targeting Claude Code and Codex. It contains:

- one portable `curate-audiobooks` Skill describing the plan-first, receipt-backed workflow;
- one shared curator core used directly by a TypeScript MCP server and a globally installable `audiobook-curator` CLI;
- no hooks;
- no dependency on the other repository, its Python implementation, or an already-installed curator executable.

The curator core orchestrates system `ffprobe` and `ffmpeg` executables directly, never through a shell. Executable paths can be injected for tests and controlled deployments; production defaults resolve `ffprobe` and `ffmpeg` on `PATH`. The package exposes a `bin` entry so the same core can be installed globally without inventing a new Agent Bundle manifest concept.

The initial tool set is intentionally small:

1. `inspect_sources` for bounded recursive audio inventory and deterministic source inspection;
2. `prepare_audiobook` for conversion planning or explicitly approved application;
3. `audit_audiobook` for structural, hash, and optional bounded full-decode verification.

Each tool uses a strict input schema and returns an RSC-rendered text summary plus a detached receipt as `structuredContent`. Child-process stdout and stderr are UTF-8 byte-bounded, cancellation terminates the owned process, and traversal/file/output limits are explicit. The CLI renders the same receipts as bounded JSON and chooses an exit status from the typed result.

Mutation-capable operations are plan-only by default. Application requires `apply: true`; the Skill instructs the agent to obtain explicit user approval first. Conversion writes to a curator-owned temporary destination, verifies the new file, then atomically promotes it to a separate output root. Original media is never deleted, renamed, overwritten, or selected as an output path.

Audible edition lookup, Whisper transcription, and acoustic matching are useful later integrations, but they do not block the first complete inventory/prepare/audit product. Their credentials and heavyweight dependencies stay outside the initial bundle.

## Why Skills stay Markdown

Skills are authored as native Markdown because Claude, Codex, and portable Agent Bundle targets consume that format directly. RSC is used where request-dependent output adds value: rendering MCP results. Adding a build-time JSX-to-Markdown Skill compiler is outside this scope.

## Verification

Automated verification covers:

- RED-to-GREEN unit tests for every public RSC export and lowerer boundary;
- package typecheck, build, pack, and isolated consumer import;
- synthetic `ffprobe`/`ffmpeg` process tests for success, malformed output, bounded output, cancellation, timeout, plan-only behavior, and explicit apply forwarding;
- direct CLI tests proving the globally installable command and MCP server share the same curator core contracts;
- full Agent Bundle build and validation for Claude and Codex;
- the existing RSC runtime example after migration.

Real-world verification globally installs the newly built CLI, installs the generated Claude and Codex bundles in isolated host homes, and invokes their inventory/audit tools against one bounded child of the mounted ZeroFS audiobook volume. This acceptance is read-only: no `apply`, metadata mutation, chapter mutation, conversion, overwrite, deletion, or rename. Receipts live in a test-owned temporary directory. Verification records the exact CLI, bundle, host, bounded fixture, and result without exposing unrelated audiobook filenames or media contents.

## Non-goals

- Implementing media codecs, Audible integration, Audiolocate, Whisper, or acoustic matching in the initial slice; the core orchestrates system ffprobe/ffmpeg.
- Bundling credentials, Python environments, media, receipts, or machine-specific paths.
- Distributed runtime state or a general JSX plugin-definition framework.
- Native hooks for audiobook operations.
