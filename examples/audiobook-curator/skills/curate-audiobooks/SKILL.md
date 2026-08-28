---
name: curate-audiobooks
description: Inventories, matches, converts, repairs, and audits audiobooks with immutable sources, explicit mutation, Audible review, and optional acoustic or Whisper evidence.
---
# Curate audiobooks

Use this Skill for complete audiobook-library curation: inventory and source
selection, Audible edition matching, conversion, metadata/artwork and chapter
repair, acoustic or transcript evidence, and final integrity audit.

## Safety boundary

- Treat every source as immutable. Never rename, delete, overwrite, or use a
  selected source path as a conversion output.
- Start with `inventory_sources` or `audit_library`, then use `select_sources`.
- Treat `convert_audiobook`, `apply_audiobook_metadata`, and
  `apply_audiobook_chapters` as plans unless `apply: true` was explicitly
  approved for the exact paths and evidence shown to the user.
- Convert into local scratch or another derived destination. Metadata/chapter
  repair is appropriate only for an explicitly selected derived file.
- Audible ranking is evidence, never acceptance. Record the user's reviewed
  choice with `select_audible_edition`.
- An Audiolocate match is strong same-recording evidence, but does not choose an
  edition. Whisper transcript windows require human language/story/narrator
  review. Never infer identity from a filename alone.
- Finish changed media with `audit_audiobook`; request full decode when complete
  decode evidence is wanted.

## Workflow

1. Inventory the narrowest selected library root and retain probe failures.
2. Audit gaps, duplicate candidates, and multipart groups; make no deletion
   claims.
3. Select the best probed encoding while retaining alternates and duration
   review warnings.
4. Search Audible regions, inspect the exact score facets, optionally collect
   acoustic/transcript evidence, and record one human-reviewed edition.
5. Cache the reviewed product, chapter document, artwork, and source URLs.
6. Plan conversion. After explicit approval, apply it to a separate output and
   confirm sources remained unchanged.
7. Plan then explicitly apply metadata/artwork and chapter repair to the derived
   media when needed.
8. Run the integrity audit and report chapter, hash, source-mapping, probe, and
   decode status without overstating inconclusive evidence.

The CLI script exposes the same operations when a terminal workflow is more
appropriate than individual MCP calls.
