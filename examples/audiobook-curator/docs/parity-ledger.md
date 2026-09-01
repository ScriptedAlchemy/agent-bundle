# Audiobook Curator parity ledger

This file is the completion contract for the TypeScript/RSC recreation. The
behavior oracle is `/fast/projects/audiobook-curator` at the repository revision
recorded during the 2026-08-26 port. A row is complete only when its production
owner and evidence are both present; a missing optional executable may make a
real-host check unsupported, but may not remove the implementation or synthetic
adapter coverage.

## Shared contracts

| Requirement | TypeScript owner | Required evidence |
| --- | --- | --- |
| Exit 0 completed, 1 failed, 2 review/inconclusive | RSC operation CLI projections | CLI contract tests for all three exits |
| Receipt contains `generatedAt`, `operation`, mutation fact | receipt foundation | strict receipt tests |
| JSON output refuses audio suffix and input/media collisions | receipt foundation | path matrix tests |
| Sources are immutable; mutation is plan-only without explicit `apply` | mutation foundation | real/synthetic before-and-after hashes |
| No shell execution; bounded output; caller cancellation; no local media deadline | capability/process foundation | child-process tests |
| Natural ordering, Unicode-safe identity, safe filenames without apostrophes | domain text foundation | ported pure tests |
| Claude and Codex derive Skill, script, and MCP from one config plus conventions | `agent-bundle.config.ts`, `src/mcp/curator/` route tree | artifact and installed-host tests |

## Operations

| CLI | MCP | Required behavior | Production owner | Evidence |
| --- | --- | --- | --- | --- |
| `inventory` | `inventory_sources` | file/directory input, natural order, per-file probe errors, strict result | inventory | ported inventory + real ZeroFS |
| `library-audit` | `audit_library` | bounded concurrency; missing metadata/artwork/chapters; duplicates; multipart; no deletion advice | library | ported library tests + ZeroFS |
| `select` | `select_sources` | collision key keeps parts; quality ordering; material duration review | selection | pure selection tests |
| `convert` | `convert_audiobook` | plan/apply, single M4B copy, multipart FFmpeg/Forge, AAC/ALAC, chapters, verification, atomic output | conversion | ported synthetic + real ffmpeg matrix |
| `audible-search` | `search_audible` | all regions, normalized evidence, original score, retained errors, human-review gate | Audible | scoring/network tests |
| `audible-select` | `select_audible_edition` | one-based explicit reviewed choice and note | Audible | selection tests |
| `audible-cache` | `cache_audible_edition` | product/chapter/cover/source URL cache and retained chapter error | Audible | injected HTTP/download tests |
| `apply-metadata` | `apply_audiobook_metadata` | catalog normalization, artwork/overrides, stream-copy, all invariants, atomic replace | metadata | ported ffmpeg fixture tests |
| `apply-chapters` | `apply_audiobook_chapters` | generic/Audible input, continuity/bounds/titles, stream-copy, all invariants | chapters | pure + ffmpeg fixture tests |
| `acoustic-verify` | `verify_audible_sample` | optional Audiolocate, sample retrieval, same-recording evidence | acoustic | injected adapter tests |
| `acoustic-identify` | `identify_audible_sample` | score ordering, ASIN dedupe, top/all, skip/error isolation, early match | acoustic | ported candidate tests |
| `whisper-verify` | `verify_with_whisper` | distributed windows, PCM extraction, transcript threshold, review result | Whisper | injected CLI + window tests |
| `audit` | `audit_audiobook` | chapters, expected source map, file/audio hashes, probe, optional full decode | audit | ported pure + real ffmpeg tests |

## Conversion matrix

| Behavior | Required evidence |
| --- | --- |
| Existing output rejected unless explicit overwrite during apply | output policy tests |
| Output never equals a selected source | path tests |
| Single M4B preserves encoded audio hash | real fixture test |
| Multipart chapter title/order follows natural selected input order | real fixture test |
| Default FFmpeg AAC uses reviewed bitrate and preserves safe layout | command + real fixture tests |
| ALAC preserves decoded PCM, original sample rate, and safe channel layout | real fixture tests |
| ALAC splits long single/few inputs into >=2-second PCM chunks for workers | pure planning + fixture tests |
| AAC remains one segment per input | command test |
| Mixed rate/channels/layout or nonuniform encoded segments fail | property matrix tests |
| ALAC rejects >6/unsafe layout and meaningful >24-bit source | property matrix tests |
| AAC rejects >96 kHz implicit downsample | property matrix test |
| Audiobook Forge is optional and produces exactly one M4B | injected CLI tests |
| Staged output verifies duration, chapter count/mapping, stream properties, then atomically publishes | failure injection + fixture tests |

## Audible score identity

The score must remain: title `+40`; author `+25`; narrator `+15/-15`;
English language `+10/-10`; unabridged `+10/-25`; duration
`max(-20, 20 - differencePercent * 4)`. Strict identity requires all positive
facets and at most 2% duration difference when duration evidence exists.

Regions: `us`, `uk`, `ca`, `au`, `fr`, `de`, `jp`, `it`, `in`, `es`.

## Metadata and chapter invariants

- Product authors/narrators are joined with ` & `; publisher HTML is stripped.
- Metadata application rejects unsupported non-chapter data streams.
- Every encoded audio stream hash must remain unchanged.
- Existing chapter rows and duration remain unchanged during metadata updates.
- Explicit audio language and required global tags are verified after staging.
- Artwork replacement preserves the non-artwork stream inventory.
- Chapter input accepts direct rows or Audible `chapter_info`/`chapters` data.
- Chapter start/end are positive, adjacent within 50 ms, begin within 100 ms,
  and finish within one second of media duration.
- Chapter repair preserves all audio hashes, non-chapter stream signature,
  stable format tags, media duration, titles, and boundaries.

## Optional evidence integrations

- Audiolocate is an injected capability; missing installation returns actionable
  unsupported evidence.
- A positive acoustic match is strong recording evidence but never bypasses
  `audible-select`.
- Whisper samples fractions `.05,.275,.5,.725,.95,.15,.85,.375,.625,.25,.75`,
  starts with five windows, and stops after at least three usable transcripts.
- Whisper windows are 35-second mono 16 kHz PCM by default; at least 80 normalized
  characters make a window usable.
- Optional capabilities, models, credentials, caches, and media are never bundled.

## Real acceptance

- [x] Read-only ZeroFS inventory: one 35,713,765-byte AAC M4B was probed from
  the mounted volume with all six chapters retained.
- [x] Read-only ZeroFS library audit: the same bounded source completed with no
  probe errors or source mutation.
- [x] Read-only selection and integrity audit: selection retained its evidence;
  the audit verified file/audio hashes and chapter structure.
- [x] Derived local-scratch conversion with source hashes unchanged: single-M4B
  stream copy published locally while the mounted source remained at SHA-256
  `4846aa3370ae737b7c2b2e61dad55c05020d4043687c5ffdf2d9d8a825de8ffa`.
- [x] Metadata/artwork/chapter verification on derived media: the live Audible
  product and artwork were applied, source chapter rows were reapplied, every
  encoded-audio hash stayed equal, and a complete decode passed.
- [x] Audible search/cache: four live regions were ranked, the embedded
  `B00QMSJC4O` edition was reviewed, and product/chapter/artwork evidence was
  cached. Its longer catalog chapter document was correctly rejected for the
  mounted recording.
- [x] Audiolocate real run: the selected legacy Python environment processed the
  public Audible sample, retained nine matches below its threshold, and returned
  an honest inconclusive result rather than asserting identity.
- [x] Whisper host check: `whisper-cli` and a model are not installed on this
  host; the explicit unsupported boundary remains covered by the real process
  adapter and distributed-window contract tests.
- [x] Claude installed MCP catalog and representative invocation: the generated
  user plugin connected and `inventory_sources` returned one AAC file with six
  chapters.
- [x] Codex installed MCP catalog and representative invocation: the generated
  plugin's `audit_audiobook` returned verified status and the source SHA-256.
- [x] Bundled script and globally linked CLI parity: both independently
  inventoried the mounted source through the generated operation catalog. The
  former Python wrapper remains preserved under a legacy backup name.
