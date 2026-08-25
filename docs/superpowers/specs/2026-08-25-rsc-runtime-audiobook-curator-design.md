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

`examples/audiobook-curator` is a public Agent Bundle example targeting Claude Code and Codex. It contains:

- one portable `curate-audiobooks` Skill describing the plan-first, receipt-backed workflow;
- one TypeScript MCP server exposing a small set of phase-oriented audiobook tools;
- no hooks;
- no copied Python implementation and no dependency on the other repository's source tree.

The MCP adapter executes a configured `audiobook-curator` binary directly, never through a shell. The executable is selected from `AUDIOBOOK_CURATOR_BIN` or `audiobook-curator` on `PATH`. Startup preflight returns an actionable error when it is unavailable.

The initial tool set is intentionally small:

1. `inspect_sources` for library audit, inventory, and deterministic selection;
2. `identify_edition` for Audible search/review/cache and optional acoustic or speech evidence;
3. `prepare_audiobook` for conversion, metadata, and chapter plans or explicitly approved application;
4. `audit_audiobook` for structural, hash, and optional full-decode verification.

Each tool uses a strict discriminated input schema, supplies its own receipt path, and returns an RSC-rendered text summary plus the parsed JSON receipt as `structuredContent`. Child-process stdout and stderr are UTF-8 byte-bounded. Cancellation terminates the owned process. Exit code `0` is success, `2` is a review-required non-error result, and other exits are bounded operational failures.

Mutation-capable operations are dry-run by default. The adapter emits `--apply` only when the MCP input contains `apply: true`; the Skill instructs the agent to obtain explicit user approval first. Original media is never deleted, renamed, or selected as an output path.

## Why Skills stay Markdown

Skills are authored as native Markdown because Claude, Codex, and portable Agent Bundle targets consume that format directly. RSC is used where request-dependent output adds value: rendering MCP results. Adding a build-time JSX-to-Markdown Skill compiler is outside this scope.

## Verification

Automated verification covers:

- RED-to-GREEN unit tests for every public RSC export and lowerer boundary;
- package typecheck, build, pack, and isolated consumer import;
- fake-executable MCP tests for success, review-required, malformed receipt, bounded output, cancellation, timeout, and explicit apply forwarding;
- full Agent Bundle build and validation for Claude and Codex;
- the existing RSC runtime example after migration.

Real-world verification installs the generated Claude and Codex bundles and invokes their MCP tools against the mounted ZeroFS audiobook volume. This acceptance is read-only: inventory, selection planning, and audit without `--apply`, metadata mutation, chapter mutation, conversion, overwrite, deletion, or rename. The test records the exact bundle, host, selected bounded fixture directory, receipt, and result without exposing unrelated audiobook filenames or media contents.

## Non-goals

- Reimplementing ffmpeg, Audible, Audiolocate, Whisper, or the Python curator in TypeScript.
- Bundling credentials, Python environments, media, receipts, or machine-specific paths.
- Distributed runtime state or a general JSX plugin-definition framework.
- Native hooks for audiobook operations.
