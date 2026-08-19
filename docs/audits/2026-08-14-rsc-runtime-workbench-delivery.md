# RSC Runtime Workbench Delivery Audit

## Candidate

- Initial audited candidate base: `acce996a2550d642abc50eca639d01d6e3741137`.
- Initial reviewed head: `d4657a2f671200058c34dd8d239aa0ff1d5b1720`.
- Resolution head before this report: `fe1c3b4c82188ee2d53314c011da508933e74699`.
- Final fully tested product/evidence head: `8db585f9d7ea0eeef7b3fdc7cbb9e3601e0f5db7`.
- The initial inventory was 0 Critical, 17 Important, and 3 Minor findings.
  Targeted fixes and originating re-reviews leave 0 unresolved findings.

## Fresh Verification Evidence

Final closure evidence collected on 2026-08-19 is retained under
`/tmp/rsc-runtime-delivery/final-20260819`:

- root `npm test` on committed `8db585f`: 165 passed files and 2151 passed / 7
  skipped tests, with zero failures (`root-test-final-committed.log`);
- the installed-tarball browser/Agent API case and its exhaustive outage-ledger
  contract: 2/2 (`packed-release-e2e-final-green.log`);
- full example suite: 15 files and 169 passed / 6 skipped tests; Runtime
  coverage: 5 files and 89/89 tests with 91.19% line coverage; focused browser:
  8 files and 39/39 tests;
- release verification: 4 files and 14/14 tests, including pack, legal-notice,
  installed-consumer, and packed-release checks (`release-check.log`);
- root/example/Workbench builds and typechecks, root lint, and generated Runtime
  topology checks exited zero in their separately named logs.

The final independent re-reviews are closed: architecture/concurrency and
security/protocol are RESOLVED, packaging/cross-host is RESOLVED, frontend
fidelity/accessibility is APPROVED, and the final Runtime model/Workbench
authority reviews are CLEAN. The last Important issue found by independent
review—instance-bound Runtime App state surviving a foreground server
replacement—was repaired by `a12f93d` and verified by a 38/38 focused suite,
including held-operation, consent, cursor, and fresh-binding reuse cases.

Task 5 full-release evidence was collected from the fully tested `a8044a2`
candidate and retained under `/tmp/rsc-runtime-delivery/final/20260817T132607Z-a8044a2`:

- root direct Rstest: 101 passed / 1 skipped files and 1287 passed / 4 skipped
  tests (`root-test-verbose.log`);
- example direct Rstest: 15 passed files and 152 passed / 6 skipped tests
  (`example-test-verbose.log`);
- focused core, Workbench, coverage, browser, and example logs: 401/1 skipped,
  343, 85, 35, and 42 tests respectively;
- deterministic native-evidence evaluator: 11 tests (`eval-evidence.log`);
- root/example/Workbench build and typecheck, root lint, and topology each exited
  zero in separately named logs.

Post-remediation release verification through
`9fb7e130440fc80ff185de10bd0f333f80162c9d` is retained under
`/tmp/rsc-runtime-delivery/final/20260817T214017Z-task6-final`:

- root direct Rstest: 103 passed / 1 skipped files and 1318 passed / 4 skipped
  tests;
- example direct Rstest: 15 passed files and 167 passed / 6 skipped tests;
- focused core: 25 passed / 1 skipped files and 425 passed / 1 skipped tests;
- focused Workbench, coverage, browser, and example: 22 files / 358 tests,
  5 files / 89 tests, 8 files / 35 tests, and 8 files / 113 passed / 6 skipped
  tests respectively;
- root/example/Workbench build and typecheck, root lint, and topology each
  exited zero; capture and widget capture also exited zero.

## Native Host Evidence

Real Claude and Codex/native-host evaluations were not run by retained user
authority. Deterministic evaluator tests are not native certification, and this
report does not reuse prior native output as fresh evidence.

## Browser and HMR Evidence

`2b1cd44` adds the composition contract recorded by
`26-capture-contract-green.log`, `27-runtime-playground-hmr.log`, and
`30-capture-tracked-evidence.json` in the post-remediation log directory. It
requires the compile-error raster to contain the selected generation-2 compact
run, `Last good: generation-2`, and AB8206 simultaneously. The capture records
generation 1 → 2 across HMR and generation 3 on recovery, preserves the
Workbench document time origin and opaque sandbox origin, and observes 390×844
bounds/zero scroll. `9fb7e13` contains the six refreshed rasters, visually
approved and superseding `d4657a2`; `30-capture-tracked.log` records their final
hashes. `812ec86` refreshes the retained delivery evidence and cross-instance
recovery narrative. Widget capture also exited zero.

## Architecture and Ownership

Architecture and concurrency findings are resolved by targeted lifecycle tests:
generation preparation and token-terminal cleanup drain before close; startup,
artifact, and live-session ownership settle every registered resource; and
runtime execution plus consent work carry cancellation through their owning
controllers. The singleton boundary remains one Workbench root, one
ProjectClient/EventSource, one McpAppClient, one shared McpSessionController,
and a Runtime controller only when the authoritative capability is configured.

## Correctness and Concurrency

All architecture/correctness rows have a reproduced contract, a bounded repair,
and focused verification recorded in the ledger. The fixes preserve existing
generation, session, artifact-history, and consent authority rather than adding
protocol retries or a new global timeout policy.

## Security and Protocol

All security/protocol rows have canonical admission or ownership boundaries and
adversarial focused coverage. Runtime operation deadlines are backend-owned;
Playground rollback quarantines verified identities; and finite JSON accepts
only descriptor-safe values.

## Frontend, DX, and Accessibility

The Runtime UI now has live failure announcements, explicit prior-provider
last-good presentation, 40px Runtime interaction targets, accessible consent
behavior, and a roving MCP presentation tablist. Fidelity conclusions remain
limited to the approved 1440×900 desktop and 390×844 mobile evidence; the
initial 1536×1024 viewport allegation was rejected/narrowed, while the accepted
fidelity-evidence closure row remains Important because it governs the accuracy of
the delivery ledger itself.

## Packaging

Packaging findings are resolved by deterministic package, legal-notice,
hook-shell, documentation, and evaluator contracts. These contracts prove the
local package boundary; they do not certify a real external host.

## Cross-host Behavior

Portable, ChatGPT/OpenAI, and Claude profiles remain local compatibility
simulations. The evaluator records unavailable host evidence truthfully, and no
simulation is represented as vendor certification.

## Finding Ledger

| ID | dimension | severity | exact evidence path / symbol / lines | finding | disposition | fix commit | verification | remaining limitation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ARC-01 | architecture/correctness/concurrency | Important | `packages/agent-bundle/src/dev/runtime-generation-store.ts` — prepare/abort terminal cleanup and `close()` drain | Generation close could race an in-flight prepare or prepared-token abort cleanup. | resolved | `c04215f`, `e86caaf` | Store/provider/registry/controller 119/119; root typecheck/lint/build green. | Targeted lifecycle evidence; TraceDecay daemon was unavailable and no database was queried. |
| ARC-02 | architecture/correctness/concurrency | Important | `examples/rsc-agent-runtime/src/dev/rsbuild-runtime-session.ts` — `ResourceLedger` and startup catch | Startup ledger cleanup could hide an owned cleanup failure. | resolved | `5f563c9`, `b7081c1` | Provider 29/29; invocation/materializer 45 passed / 6 skipped; root typecheck/lint/build green. | Fixed resource labels bound cleanup detail. |
| ARC-03 | architecture/correctness/concurrency | Important | `examples/rsc-agent-runtime/src/dev/rsbuild-runtime-session.ts` — `#releaseRunArtifact()`, `#evictTerminalRuns()`, `readRunFlight()` | Run-artifact cleanup could lose ownership, admit a late reader, or retain history after release. | resolved | `d36166e`, `0182547` | Invocation 29 passed / 6 skipped; held-reader reservation and post-release directory-failure contracts green. | Public cleanup messages expose fixed labels only. |
| ARC-04 | architecture/correctness/concurrency | Important | `examples/rsc-agent-runtime/src/dev/rsbuild-runtime-session.ts` — `#close()`, `#closeRunArtifacts()` | Live session close could fail fast before independently owned resources settled. | resolved | `d36166e`, `0182547` | Provider 30/30; injected independent close failures prove every resource group settles once. | Underlying causes remain contained in the AggregateError. |
| ARC-05 | architecture/correctness/concurrency | Important | `packages/workbench/src/mcp/mcp-session-controller.ts`; `packages/workbench/src/mcp/mcp-route-client.ts`; `packages/workbench/src/mcp/mcp-app-client.ts`; `packages/workbench/src/inspector/adapter/runtime-app-bridge.ts`; `packages/workbench/src/main.tsx` | Runtime execution and held Runtime App consent phases lacked complete cancellation ownership. | resolved | `2d4aa9e`, `62a16ea`, `00d1d76`, `460f3de` | Controller route/App 46/46; bridge 15/15; focused controller/client/queue/bridge 95/95; affected Workbench 217/217; real App consent 3/3. | Server expiry/revocation remains authoritative; no retry or timeout policy was added here. |
| SEC-01 | security/protocol | Important | `packages/agent-bundle/src/dev/mcp-app-action-validation.ts`; `packages/workbench/src/inspector/adapter/runtime-app-bridge.ts` | Runtime bridge link/download validation was weaker than the canonical route boundary. | resolved | `94e38fe` | Backend/Workbench/client bridge 79/79; root typecheck/lint/build green. | Canonical validator remains the single browser-safe admission contract. |
| SEC-02 | security/protocol | Important | `packages/agent-bundle/src/dev/mcp-app-runtime-preview-service.ts`; `packages/agent-bundle/src/dev/mcp-app-runtime-binding-service.ts`; `packages/agent-bundle/src/dev/mcp-app-routes.ts` | Runtime App operations lacked a backend-owned bounded execution deadline. | resolved | `8042f08` | Controlled 30-second timeout/reclaim, disconnect, late-settlement, and abort contracts; preview/binding/routes/registry 71/71. | No retry policy was introduced. |
| SEC-03 | security/protocol | Important | `packages/agent-bundle/src/services/playground-service.ts` — cold v2 admission, quarantined identity-checked rollback, and `close()` drain | Cold Playground rollback could delete a replaced public pathname. | resolved | `7322db9`, `8e830ca` | Direct-root and parent-symlink substitutions preserve foreign content; `playground-service.test.ts` 56/56. | No public pathname is recursively deleted after a public-path check. |
| SEC-04 | security/protocol | Important | `packages/agent-bundle/src/services/playground-service.ts` — `json()` | Playground finite-JSON admission did not validate array/object descriptors. | resolved | `c36d4f2` | Playground 51/51; adjacent Playground/hook/normalization 78/78; root typecheck/lint/build green. | Deep-frozen detached finite JSON remains the accepted representation. |
| FE-01 | frontend/DX/accessibility | Important | `packages/workbench/src/runtime-model.ts`; `packages/workbench/src/runtime-playground.tsx` | Build failure announcement could be absent while Result stayed selected. | resolved | `44c282e` | Deduplicated generation-scoped assertive alert preserves Result and last-good output; model/browser/HMR regression coverage green. | HMR test exercises the real no-generation-id event shape. |
| FE-02 | frontend/DX/accessibility | Important | `packages/workbench/src/runtime-model.ts`; `packages/workbench/src/runtime-playground.tsx` | Previous-provider last-good presentation lacked explicit transition behavior. | resolved | `44c282e` | Session-only prior-provider output remains labelled until new-provider success; model/UI regression coverage green. | Fixture has no truthful in-place provider-restart control. |
| FE-03 | frontend/DX/accessibility | Important | `packages/workbench/src/styles.css`; `packages/workbench/src/mcp/mcp-json-input.tsx`; `packages/workbench/tests/mcp-json-input.test.ts`; `packages/workbench/tests/runtime-playground.e2e.test.ts` | Runtime controls could fall below the 40px target at mobile width. | resolved | `3a6dd11`, `0e64c58`, `5ddec84` | Real 390px flow measures selects, text/number inputs, radio/checkbox labels, Run, reset, history, and confirmation controls at >=40px with no clipping; boolean glyph stays inside its semantic label. | Scoped Runtime sizing does not redefine global button sizing. |
| FE-04 | frontend/DX/accessibility | Important | `packages/workbench/src/main.tsx`; `packages/workbench/src/mcp/runtime-consent-queue.ts`; `packages/workbench/src/mcp/runtime-consent-dialog.tsx`; `packages/workbench/tests/runtime-consent-dialog.test.ts`; `packages/workbench/tests/mcp-app-real.e2e.test.ts` | Action-consent modal accessibility and same-layout queue correlation needed adversarial review. | resolved | `e2abb5c`, `1f607de` | Named modal, inert background, focus wrap/restore, Escape deny, FIFO advancement, and exact-entry gesture latching pass focused and real-App coverage. | The cancellation/FIFO contract remains controlling. |
| FE-05 | frontend/DX/accessibility | Important | `docs/assets/rsc-runtime-workbench/fidelity-ledger.md`; `packages/workbench/scripts/capture-runtime-playground.mjs` | Capture fidelity, image size, and evidence dispositions needed accurate delivery closure. | resolved | `7e62e6b`, `fa745d9`, `a0ebe2a`, `2b1cd44`, `9fb7e13`, `812ec86` | Refreshed approved PNGs and the capture contract prove exact 1440×900 and 390×844 states; every ledger row is evidence-limited as Verified, Intentional deviation, or Not visually evidenced. | Fidelity rows explicitly marked Not visually evidenced remain limited; the rejected 1536×1024 allegation is not represented as a validated capture requirement. |
| PKG-01 | packaging/cross-host | Important | `examples/rsc-agent-runtime/README.md`; `examples/rsc-agent-runtime/tests/docs-contract.test.ts` | README native-host wording could overstate certification without attached real-host evidence. | resolved | `28d92fd` | Docs contract 2/2; docs/evaluator/host-artifacts 24/24; full example 15 files, 167 passed / 6 skipped. | Real Claude/Codex evaluation was not run by retained authority. |
| PKG-02 | packaging/cross-host | Important | `examples/rsc-agent-runtime/scripts/eval-evidence.mjs`; `examples/rsc-agent-runtime/scripts/eval-hosts.mjs` | Native evidence attribution could credit lookalikes, mixed results, or unrelated state. | resolved | `e95483e` | Exact tool/result IDs, bounded content, and per-run marker correlation; evaluator/docs/host-artifacts/empty-PATH 24/24; full example 15 files, 167 passed / 6 skipped. | Deterministic evaluator success is not native certification. |
| PKG-03 | packaging/cross-host | Important | `examples/rsc-agent-runtime/packaging/claude/hooks/hooks.json`; `examples/rsc-agent-runtime/packaging/codex/hooks/hooks.json`; `examples/rsc-agent-runtime/tests/host-artifacts.test.ts` | Packaged hook roots were unquoted and could split an executable path. | resolved | `2c853ab` | Claude/Codex copied packages execute via declared `/bin/sh -c` from roots containing spaces and `;`; host artifacts 4/4. | No real native host was contacted. |
| MIN-01 | security/protocol | Minor | `packages/agent-bundle/src/dev/mcp-app-action-validation.ts`; `packages/workbench/src/mcp/mcp-app-client.ts` | Missing-host `ui:` URI acceptance needed runtime-client parity. | resolved | `94e38fe` | Runtime client rejects `ui:/...` and `ui:///...` before policy installation; bridge/client/backend 79/79. | Existing config and metadata host requirements remain unchanged. |
| MIN-02 | frontend/DX/accessibility | Minor | `packages/workbench/src/main.tsx`; `packages/workbench/tests/inspector-shell.e2e.test.ts` | MCP tablist keyboard interaction needed a complete ARIA model. | resolved | `e2abb5c` | One roving tab stop and Arrow/Home/End selection/focus pass without changing MCP session lifecycle. | Inspector remains a nested MCP presentation, not a shell page. |
| MIN-03 | packaging/cross-host | Minor | `examples/rsc-agent-runtime/rsbuild.config.ts`; `examples/rsc-agent-runtime/tests/host-artifacts.test.ts` | App legal payload names and self-contained HTML license references were unstable/dangling. | resolved | `bf166d5`, `9d51931` | Fresh production output has root-stable `lib-react.js.LICENSE.txt`; every declaration resolves inside dist/Claude/Codex payloads with byte/hash parity. | Notices remain linked and are not discarded. |

## Generated Topology Synchronization

Topology synchronization is follow-up work outside the 20-finding inventory.
`8c0688d` regenerated the architecture marker block, `4d23c9f` retained the two
Runtime consent production owners, and `fe1c3b4` retained the Runtime action
validator. The final `npm run check:runtime-topology` exited zero; focused
`rsc-runtime-topology-script.test.ts` passed 2/2 for both retention follow-ups.

## Remaining Limitations

- TraceDecay diagnostics could not connect to the local daemon socket, and no
  database was queried.
- Real Claude/Codex/native-host evaluation was not run by retained user
  authority; deterministic evaluator coverage is deliberately not certification.
- The fidelity ledger's rows explicitly labelled Not visually evidenced remain
  limitations of visual proof, even where implementation or automated behavior
  exists.
