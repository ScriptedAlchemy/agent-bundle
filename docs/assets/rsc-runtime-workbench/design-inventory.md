# Runtime Playground visual contract

## Reference and provenance

This inventory describes the selected concept raster, not a bitmap to be shipped as
the UI. The selected ImageGen output was:

- Generation filename: `exec-db66ae91-389f-4513-a9c4-be859025dab9.png`
- Source: `/home/zack/.codex/generated_images/019ffeae-debd-7560-a740-751b451789a4/exec-db66ae91-389f-4513-a9c4-be859025dab9.png`
- Copied reference: `desktop-concept.png`
- Actual file metadata: `PNG image data, 1536 x 1024, 8-bit/color RGB,
  non-interlaced` (reported by `file`)

The concept was inspected at `detail: original`. `identify` was not installed in
the environment (nor were `pngcheck`, `sips`, or `exiftool`), so dimensions are
recorded from the safe `file` result. No image tooling was installed. The concept
is a dense developer-tool reference at its native 1536×1024 viewport; responsive
behavior below is an implementation continuation, not additional raster evidence.

## Visual rules extracted from the raster

### Palette

The surface is true white (`#ffffff`) with near-black primary text (approximately
`#171a1f`). Panels and controls use cool gray 1px rules (approximately
`#d5dbe3`), with very light gray fills (approximately `#f7f9fb`) for code, table,
and selected-row surfaces. Cobalt is the only strong accent (approximately
`#0b5bd3` to `#155eef`): it marks active tabs, links, focused controls, the Run
action, generation chips, and the documentation outline. Success is a compact
green dot/check/badge (approximately `#2e9d58` with a pale green backing); the
`ACTIVE`, `SHIPPED`, and `SUCCESS` labels stay restrained. Error red is not
shown in this successful frame, but diagnostics must reserve the existing
Workbench red treatment (dark red text/rule on a pale red surface), never invent
a new status color. Text-muted is a cool slate gray (approximately
`#5c6676`).

Do not add gradients, shadows that read as cards, marketing color blocks, fake
host-certification colors, or decorative dashboard colors. The simulated-host
disclaimer remains neutral gray.

### Type scale and density

The visual language is compact sans-serif UI text with monospace values for JSON,
opaque identifiers, revisions, epochs, event sequences, and trace details.
Treat these as starting tokens and confirm them against the later capture:

| Token | Concept treatment | Intended use |
| --- | --- | --- |
| `display` | 18–20px, 650–700 | Workbench and Runtime Playground titles |
| `section` | 13–15px, 650–700 | panel titles, rail groups, inspector tabs |
| `body` | 12–14px, 400–600 | labels, values, controls, table cells |
| `meta` | 10–12px, 400–700 | identity labels, timestamps, durations, badges |
| `code` | 11–13px monospace, 1.45 line height | JSON, tree values, IDs, trace details |
| `fine` | 10–11px | trace headings and simulated-host disclaimer |

Use sentence case for product and operation labels. Keep uppercase for compact
status tokens (`SUCCESS`, `ACTIVE`, `SHIPPED`, `PROCESSING`) and the existing
`Form`/`Raw JSON` and inspector tab labels. Code and data are never rendered as
prose or hidden behind decorative truncation; long opaque values may wrap.

### Spacing, borders, and radii

The raster uses an approximately 4px base rhythm: 4px between an icon and its
label, 8px between label/value lines, 10–12px panel padding, 10–12px gutters,
and 16px outer page padding. The identity strip is divided by 1px vertical
rules. All panel and control outlines are 1px cool gray, with mostly square
corners or a small 4–6px radius. Status chips and badges may use a fully rounded
pill only when they communicate a state; cards do not become rounded marketing
tiles. The Run button is a full-width rail action; its implementation control is
at least 40px high even though the concept is visually compact. Focus rings must
remain visible outside the 1px border and use the same cobalt family.

## Visible copy and data in the selected frame

The following is the copy and representative data visibly rendered in the
concept. Values are fixture evidence, not contracts for a live provider.

### Workbench header and identity strip

| Region | Visible copy |
| --- | --- |
| Header | `Agent Bundle Workbench`, `Runtime Playground`, `Documentation ↗`, and an unlabeled settings gear icon |
| Provider state | `Provider active` → `Yes` |
| HMR state | `HMR endpoint ready` → `Yes` |
| Browser clients | `Browser HMR clients: 1` → `1` |
| Provider identity | `Provider session` → `ps_8f3c7a2ad` |
| Runtime identity | `Runtime generation` → `gen_00012345 (current)` |
| Source identity | `Source revision` → `a1b2c3d` |
| Artifact identity | `Artifact epoch` → `1706298287` |
| State identity | The concept shows `State store` → `memory`; `State version` → `17`. `memory` is concept-only and intentionally conflicts with the durable external-state contract. |
| Event identity | `Event sequence` → `1,284` |
| Target | The concept shows `Target` → `simulated-host`; this is a concept-only display value, not a browser-supplied target identity. |
| Profile | `Profile: Portable MCP Apps · agent-bundle:mcp-apps:2026-01-26 · Simulated` |

Each identity is independently labelled. Do not collapse the strip into one
status sentence or imply that `HMR endpoint ready` means a browser client is
connected. At implementation time, replace `memory` with the provider's opaque
durable `stateStoreId` (and its authoritative version), never module memory; use
provider-declared target IDs rather than trusting the concept's
`simulated-host` string.

### Left operation and fixture rail

The rail visibly contains the grouped operation labels `Hooks` (count `1`),
`MCP Tools` (count `3`), `MCP Resources` (count `2`), and `MCP Apps` (count
`2`), followed by `Fixtures`. The selected fixture control displays
`customer_lookup_success`. The target control is labelled `Target` and displays
`simulated-host`.

The input surface has `Form` selected beside `Raw JSON`, with fields:
`customer_id` → `cust_12345`, `include_orders` (checked), and `limit` → `5`.
Actions are `Run` and `Reset fixture state`. The history heading is
`Run history (2)` with `Clear`; its two visible immutable entries are:

1. `MCP Tool: get_customer`, `customer_lookup_success`, `10:27:14 AM`,
   `gen_00012345`.
2. `Hook: pre_tool_call`, `customer_lookup_success`, `10:27:13 AM`,
   `gen_00012345`.

Both entries show a green success check and generation chip. History is a
selection surface, not a mutable log editor.

### Center stage

The green last-good banner reads:
`All outputs are from the current runtime generation (gen_00012345). No stale views.`
It also shows `Last good: gen_00012344` and the action `View history`.

The output cards are:

- `Agent-visible output` — `SUCCESS`, `Hook: pre_tool_call`, `10:27:13 AM`,
  `56 ms`, and JSON containing `"ok": true`, `"hook": "pre_tool_call"`,
  `"allowed": true`, and `"notes": "preconditions satisfied"`.
- `Native response` — `SUCCESS`, `MCP Tool: get_customer`, `10:27:14 AM`,
  `83 ms`, a `JSON` disclosure, and a response beginning with
  `"ok": true`, `"customer": { "id": "cust_12345", "name": "Acme Corporation", ... }`,
  and `"orders": [ ... 5 items ... ]`.
- `Model-visible output` — `SUCCESS`, `For model consumption`, `10:27:14 AM`,
  `41 ms`, followed by:
  `Customer Acme Corporation (cust_12345) is active.`;
  `5 recent orders found.`;
  `Latest order (ord_1001) total $1,250.00 on 2026-01-24.`;
  `All preconditions satisfied.`

Each output card has a copy icon. The sibling card is `MCP App preview` with
open-in-new and refresh icons. Its visible App content is:

- `Customer Lookup`
- `Customer` / `Acme Corporation` / `cust_12345`
- `Status` / `ACTIVE`
- `Orders (5)`
- table headings `Order ID`, `Date`, `Total`, `Status`
- `ord_1001` / `2026-01-24` / `$1,250.00` / `SHIPPED`
- `ord_1002` / `2026-01-21` / `$880.50` / `SHIPPED`
- `ord_1003` / `2026-01-18` / `$620.00` / `PROCESSING`
- `ord_1004` / `2026-01-17` / `$410.75` / `SHIPPED`
- `ord_1005` / `2026-01-15` / `$220.00` / `SHIPPED`

The App preview is a sibling of model-visible output. It must never appear as a
child node in the decoded React tree.

### Right inspector

The inspector tabs are `Tree`, `Result`, `Flight`, `Protocol`, `State`, and
`Diagnostics`; `Tree` is selected. Its heading is `Decoded React tree`. The
controls read `Show component props`, `Expand all`, and `Collapse all`.

Visible tree labels and values are:

```text
App [root]
  CustomerLookupApp [def]
    div [container]
      header [header]
        h1 "Customer Lookup"
      CustomerSummary [def]
        section [summary]
          div [field-row]
            span [label] "Customer"
            span [name] "Acme Corporation"
            a [customer-id] "cust_12345"
            span [status-label] "Status"
            span [status-badge] "ACTIVE"
      OrdersTable [def]
        table [orders-table]
          thead [table-head]
          tbody [table-body] (5 rows)
```

The tree's labels describe decoded React output. They are not a source editor,
JSX view, or iframe representation.

### Bottom trace and footer

The full-width trace heading is `Trace (2 events)`. Columns are `#`, `Time`,
`Event`, `Type`, `Name`, `Target`, `Status`, `Duration`, `Generation`, and
`Details`. Rows show:

1. `1` / `10:27:13.476 AM` / `hook.run` / `Hook` / `pre_tool_call` /
   `simulated-host` / `success` / `56 ms` / `gen_00012345` / `allowed=true`.
2. `2` / `10:27:14.123 AM` / `tool.run` / `MCP Tool` / `get_customer` /
   `simulated-host` / `success` / `83 ms` / `gen_00012345` /
   `customer_id=cust_12345, orders=5`.

The footer controls are `Auto-scroll`, `Show details`, `Export trace (JSON)`,
`Copy trace ID`, and the opaque example `Trace ID:
trc_01H2Y9Q7X6J8V8W3N12Z`. The page disclaimer reads
`Simulated host environment. No external systems are contacted.`

## Interaction and state inventory

| State | Raster evidence | Implementation rule |
| --- | --- | --- |
| Focus | The `Documentation ↗` outline and cobalt control outlines demonstrate a visible keyboard affordance. | Preserve a 2px-equivalent cobalt focus ring with sufficient contrast; never use color-only focus. |
| Selected | `Form`, `Tree`, the current generation chip, and the highlighted history row use cobalt text/underline/outline. | One selected tab/row is exposed to assistive technology; selected history remains immutable. |
| Success/ready | Green dots for provider/HMR, green checkmarks, `SUCCESS`, `ACTIVE`, and `SHIPPED`. | Keep phase-specific status text alongside the color. |
| Stale/last-good | Banner explicitly says `No stale views` while exposing `Last good: gen_00012344`. | On a failed or stale generation, keep last-good output visible and label its generation; never relabel it current. |
| Error | No error is rendered in this successful concept. | Reserve pale-red diagnostic panels, phase label, bounded stderr, and an actionable retry/history path; do not fabricate a red state in the reference. |
| Disabled/empty | No disabled or empty state is rendered. | Keep optional Runtime absent for ordinary projects; show an explicit unavailable state only when the provider contract says so. |

## Regions and file ownership

| Region | Layout responsibility | Owning component/file |
| --- | --- | --- |
| Workbench header and Runtime route shell | Existing header, navigation handoff, route-level landmarks | `packages/workbench/src/main.tsx`, `packages/workbench/src/runtime-playground.tsx` |
| Identity strip | Provider/HMR/session/generation/state/profile identities | `packages/workbench/src/runtime-playground.tsx`, `packages/workbench/src/runtime-model.ts` |
| Operation rail | Operation groups, fixture/target selectors, history selection | `packages/workbench/src/runtime-playground.tsx`, `packages/workbench/src/runtime-model.ts` |
| Form/Raw JSON input | Schema-derived fixture controls and raw draft boundary | `packages/workbench/src/mcp/mcp-json-input.tsx`, `packages/workbench/src/runtime-playground.tsx` |
| Center stale banner | Active vs last-good generation notice and history action | `packages/workbench/src/runtime-stage.tsx` |
| Hook/MCP output cards | Agent-visible, native, and model-visible run evidence | `packages/workbench/src/runtime-stage.tsx` |
| MCP App preview | Sibling App output injection; no tree child | `packages/workbench/src/runtime-stage.tsx`, existing `packages/workbench/src/mcp/mcp-app-preview.tsx` boundary |
| Inspector | Tree/result/Flight/protocol/state/diagnostics tabs and decoded tree | `packages/workbench/src/runtime-inspector.tsx`, existing Inspector adapter presentation where shared |
| Trace | Run-local ordered spans, details, export/copy controls | `packages/workbench/src/runtime-stage.tsx`, `packages/workbench/src/runtime-model.ts` |
| Runtime data/event boundary | Authenticated status, surfaces, runs, assets, replay/reset, HMR events | `packages/workbench/src/runtime-client.ts`, `packages/workbench/src/project-client.ts` |
| Responsive tokens and composition | Grid, panel rules, focus, reduced motion, overflow bounds | `packages/workbench/src/styles.css` |

These ownership names are deliberately aligned with the approved frontend
topology. Runtime does not create a second MCP transport, session controller,
trace store, App client, or Inspector shell.

## Responsive continuation

### 1100px wide

At 1100px, preserve the header and identity strip as the first landmarks. Keep a
compact operation rail beside the center stage, but move the inspector below the
stage instead of squeezing the tree into an unreadable third column. Keep the App
preview beside the model-visible result when space permits; otherwise stack those
two center cards. The trace remains full-width below the inspector, with a bounded
table scroll region rather than document-wide overflow. Identity values may wrap
inside their own cells; they must not merge labels or become an unlabeled ticker.

### 390×844

Use one document column in visual order: header, compact identity cells, operation
groups/fixture controls, selected output cards, sibling App preview, inspector
tabs/content, then trace controls and rows. Rail groups can become disclosure
sections, but `Run`, reset, history selection, and all inspector tabs remain
reachable with 40px minimum controls. Cards and tree nodes wrap within the
viewport; long JSON/trace data gets an internal bounded scroll region. Do not
allow horizontal document overflow, hide the stale/last-good label, or place the
App iframe inside the decoded tree. Respect reduced-motion preferences and retain
the visible focus ring.
