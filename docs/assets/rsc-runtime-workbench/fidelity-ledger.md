# Runtime Playground fidelity ledger

This ledger is seeded from the selected `desktop-concept.png` generation
(`exec-db66ae91-389f-4513-a9c4-be859025dab9.png`). Render evidence is intentionally
not claimed until the Workbench implementation has been captured at the concept
viewport and at the required responsive widths.

## Current captured authority

`packages/workbench/scripts/capture-runtime-playground.mjs` records the six
captures below from one disposable Runtime fixture. The capture contract also
proves HMR/recovery identities, preserves the outer Workbench document during
App refresh, and observes the opaque App origin; its per-run JSON is kept under
`/tmp`, not tracked. The stale plan selector `data-app-status="ready"` is not
an as-built authority: readiness is the selected immutable run plus a visible
Runtime preview iframe with its binding-scoped bootstrap URL and an opaque child
heading of `Runtime edit timeline`.

| Region | Concept evidence | Acceptance | Render evidence | Disposition |
| --- | --- | --- | --- | --- |
| Header | `Agent Bundle Workbench`, separator, `Runtime Playground`, `Documentation ↗`, settings gear | Existing Workbench header remains recognizable; Runtime is a sibling route, with real landmarks and keyboard focus | Pending implementation | Pending implementation |
| Identity strip | Twelve separately labelled runtime/provider/HMR/session/generation/state/target fields; simulated Portable MCP Apps profile | Labels and values stay separate, ordered, readable, and provider-declared; browser HMR clients are not inferred from endpoint readiness | `mobile.png` (390×844) shows the separate simulated Portable App profile, version, evidence, parity, and registered-configuration fields. | Fixed |
| Provider/HMR status | Green-dot `Yes` values for `Provider active` and `HMR endpoint ready`; `Browser HMR clients: 1` is distinct | Expose phase text plus color; HMR readiness and connected-client events remain separate | `hmr-before.png` and `hmr-after.png`, paired with the capture contract, observe a real generation advance without a Workbench document reload. | Fixed |
| Generation identity | Cobalt chip `gen_00012345 (current)`; source revision, artifact epoch, and `Last good: gen_00012344` | Active and last-good identities are immutable and never crossed between generations | `compile-error.png` retains the last-good generation/run while `recovered.png` follows a new recovered generation. | Fixed |
| Left operation groups | `Hooks (1)`, `MCP Tools (3)`, `MCP Resources (2)`, `MCP Apps (2)` | Operation groups are visible, count-bearing, keyboard accessible, and provider-surface driven | Pending implementation | Pending implementation |
| Fixture selectors | `Fixtures`, `customer_lookup_success`, `Target`, `simulated-host` | Fixture and target choices are explicit; browser sends provider-declared opaque target IDs only; `simulated-host` is concept evidence, not an implementation value | Pending implementation | Intentional divergence required: replace concept-only target text with the provider target ID |
| Input tabs | `Form` selected beside `Raw JSON`; `customer_id`, `include_orders`, `limit` fields | Form and raw draft share one validated model; tab selection has accessible selected state | `compile-error.png` visibly records the selected Raw JSON input mode and detached `{}` input. | Fixed |
| Run controls | Full-width cobalt `Run`; neutral `Reset fixture state` | Read-only run affordance is immediate; reset/mutating actions have confirmation and at least 40px controls | `compile-error.png` visibly retains Run and Reset fixture state controls while a source-build diagnostic is active. | Fixed |
| Run history | `Run history (2)`, `Clear`, two green-success entries with generation chips | History is newest-first, immutable, provider-session scoped, capped at 50, and never relabels old evidence | `compile-error.png` shows immutable succeeded records from the prior generation; the capture contract verifies the failed build added none. | Fixed |
| Durable state identity | Concept displays `State store` → `memory` and `State version` → `17` | Keep the separate label/version treatment, but render the provider's opaque durable `stateStoreId`; never imply module memory or browser-owned state | Pending implementation | Intentional divergence required: replace the concept-only `memory` value with durable external-state identity |
| Last-good banner | Green banner: `All outputs are from the current runtime generation (gen_00012345). No stale views.` plus `View history` | Failed/stale output leaves last-good evidence visible with its exact generation and a phase diagnostic | `compile-error.png` shows the retained last-good identity alongside AB8206; the capture contract verifies exact run/generation retention. | Fixed |
| Agent-visible output | `SUCCESS`, `Hook: pre_tool_call`, JSON policy result, `56 ms` | Hook output presents raw bounded evidence, status, operation, duration, and copy affordance | Pending implementation | Pending implementation |
| Native response | `SUCCESS`, `MCP Tool: get_customer`, expandable `JSON`, customer/orders object | Native response preserves the provider result and does not get replaced by model prose | Pending implementation | Pending implementation |
| Model-visible output | `For model consumption` plus four-line customer/order summary | Model-visible fallback is shown beside the App only when declared and remains distinguishable from native output | `desktop.png` shows the distinct model-visible result panel with the selected run's tool result. | Fixed |
| MCP App sibling | `MCP App preview`, `Customer Lookup`, status, five-row orders table, open/refresh icons | App preview is a sibling stage surface; no iframe or App node is inserted into the decoded React tree | `mobile.png` shows the Runtime App preview as a separate stage region; `desktop.png` keeps decoded-tree copy explicit that an App frame is not part of it. | Fixed |
| App result copy | `Acme Corporation`, `cust_12345`, `ACTIVE`, `SHIPPED`, `PROCESSING`, order totals/dates | App fixture values are readable, stable, and sourced from the selected run; sandbox/profile evidence is visible but non-marketing | Pending implementation | Pending implementation |
| Inspector tabs | `Tree`, `Result`, `Flight`, `Protocol`, `State`, `Diagnostics`; `Tree` active | Six tabs are present in order, with active semantics, keyboard reachability, and bounded artifact views | Pending implementation | Pending implementation |
| Decoded tree | `Decoded React tree`; `Show component props`, `Expand all`, `Collapse all`; CustomerLookupApp/OrdersTable tree | Tree is derived from decoded React output; props toggle and expansion state are explicit; no JSX/source editor appears | Pending implementation | Pending implementation |
| Protocol/state diagnostics | Tabs are visible even though Tree is selected in the concept | Result/Flight/Protocol/State/Diagnostics retain the same panel geometry and phase-labelled error surface | `compile-error.png` records the phase-labelled `source/build error AB8206` inside Diagnostics and its render trace. | Fixed |
| Trace table | `Trace (2 events)` with ordered hook/tool rows, generation chips, status, duration, details | Run-local spans remain ordered by sequence, bounded, generation-labelled, and exportable without becoming a second durable trace store | Pending implementation | Pending implementation |
| Trace controls | `Auto-scroll`, `Show details`, `Export trace (JSON)`, `Copy trace ID`, opaque trace ID | Controls are keyboard accessible; raw export/copy are bounded and do not leak credentials | Pending implementation | Pending implementation |
| Footer disclaimer | `Simulated host environment. No external systems are contacted.` | Disclaimer is visible but subordinate; no fake certification or external-host claim is implied | Pending implementation | Pending implementation |
| Typography | Compact sans-serif labels; monospace JSON/IDs/trace; small uppercase status tokens | Type hierarchy remains legible at native and mobile widths; code never depends on color alone | Pending implementation | Pending implementation |
| Palette | White canvas, near-black text, cool gray rules, cobalt active controls, green success, neutral disclaimer | Preserve contrast and restrained developer-tool palette; no gradients or marketing cards | Pending implementation | Pending implementation |
| Container model | 1px outlined panels, 4–6px corners, dense 4px rhythm, 10–16px padding/gutters | Panels align to one grid and retain accessible hit areas without card bloat | Pending implementation | Pending implementation |
| Focus/selected states | Cobalt outline/tab underline/current chip; selected Form, Tree, history, generation | Focus is visible, selected semantics are announced, and pointer-only state is not used | Pending implementation | Pending implementation |
| Success/error states | Green dots/checks and `SUCCESS`; no error shown in the raster | Implement success and phase-labelled pale-red diagnostics; absence of an error in the concept is not evidence that error UI may be omitted | `hmr-after.png` records a succeeded replay while `compile-error.png` records the source-build error and `recovered.png` records its cleared diagnostic. | Fixed |
| Stale/last-good states | Explicit no-stale message plus prior-generation `Last good` identity | Preserve last-good output through compile/run/App failure and distinguish stale from current | `compile-error.png` and `recovered.png` are backed by the capture contract's exact last-good and recovery identity assertions. | Fixed |
| 1100px continuation | Concept is native desktop only; approved continuation moves Inspector below stage | No unreadable third column; bounded trace scroll; identity labels remain separate | Pending implementation | Pending implementation |
| 390×844 continuation | Concept is native desktop only; approved continuation stacks rail, stage, App, Inspector, trace | No horizontal document overflow; controls remain reachable at 40px minimum; reduced motion and focus retained | `mobile.png` visibly shows a settled opaque Runtime App/profile at 390×844. The capture contract records zero-scroll bounds through the host and child, but this crop does not itself show the controls. | Pending implementation |

## Update protocol

When desktop and mobile captures exist, replace each `Pending implementation` in
`Render evidence` with the capture path, viewport, and a concise observed fact.
Set `Disposition` to exactly one of `Match`, `Intentional divergence`, or `Fixed`;
use `Intentional divergence` only when the implementation is required by an
accessibility, security, responsive, or existing-Workbench constraint and record
that reason in the row. Do not mark a row from source inspection alone.
