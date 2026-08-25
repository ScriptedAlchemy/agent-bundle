---
name: curate-audiobooks
description: Inspects, prepares, and audits local audiobook media with immutable sources and explicit application.
---
# Curate audiobooks

Use this Skill when the user wants to inspect audiobook media, plan a normalized
M4B, explicitly apply a reviewed conversion plan, or audit an audiobook.

## Safety boundary

- Treat every source file as immutable. Never rename, delete, overwrite, or use a
  source path as an output path.
- Begin with `inspect_sources` on the narrowest directory the user selected.
- Call `prepare_audiobook` without `apply` first and show the planned source and
  output to the user.
- Set `apply: true` only after the user explicitly approves that exact plan.
- Use a separate output directory. Existing output files are never overwritten.
- Finish applied work with `audit_audiobook`; use `fullDecode` when the user wants
  the slower complete media decode.

## Workflow

1. Inspect the bounded source directory and summarize formats, durations, and size.
2. Select one source only when its identity is unambiguous.
3. Produce a preparation plan and disclose that no media has changed.
4. If approved, apply that exact source/output plan.
5. Audit the result and report its SHA-256, probe result, and decode status.

Audible lookup, speech transcription, and acoustic matching are not part of this
bundle. Do not claim edition identity from filenames or tags alone.
