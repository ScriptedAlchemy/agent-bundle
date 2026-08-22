# Thermo-review Refactors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the structural blockers found in PR #2 while preserving every public protocol, persisted format, route, error code, and CLI behavior.

**Architecture:** Execute four independently reviewable subsystem plans in dependency order. Browser-safe contracts land first, durable filesystem mechanisms second, lifecycle/routing cleanup third, and Playground/decode decomposition last.

**Tech Stack:** TypeScript, Node.js 22.19+, React 19, Rslib/Rsbuild/Rspack, Rstest, `@rstest/playwright`.

## Global Constraints

- Preserve all protocol, manifest, artifact, HTTP, and persisted-data formats.
- Preserve domain-specific close-error classes and failure ordering.
- Keep lock schemas, stale-owner decisions, and process-liveness policy in their current domain modules.
- Add no runtime dependency for JSON decoding or filesystem durability.
- Keep browser contract modules free of Node built-ins and service implementations.
- Use test-driven development: observe each new boundary test fail before implementation.
- End every task with affected tests and a focused commit.
- Keep imports at module top level.
- Use exhaustive `never` checks for TypeScript union/enum switches.

## Execution Order

- [ ] **Plan 1:** Execute `docs/superpowers/plans/2026-08-19-workbench-contracts-json-plan.md`.
- [ ] **Checkpoint:** Run `npm run build && npm run typecheck`; confirm the workbench boots in a real browser.
- [ ] **Plan 2:** Execute `docs/superpowers/plans/2026-08-19-durable-filesystem-plan.md`.
- [ ] **Checkpoint:** Run the dev-lock, epoch-store, eval-run-store, Playground, and native-Playground affected tests.
- [ ] **Plan 3:** Execute `docs/superpowers/plans/2026-08-19-lifecycle-routing-types-plan.md`.
- [ ] **Checkpoint:** Run Agent API, foreground server, route, shutdown, and workbench-server affected tests.
- [ ] **Plan 4:** Execute `docs/superpowers/plans/2026-08-19-playground-decomposition-decoder-plan.md`.
- [ ] **Checkpoint:** Confirm `playground-service.ts` is below 1,000 lines and no view owns transport lifecycle logic.
- [ ] **Final verification:** Run `npm run check && npm run check:release`.
- [ ] **Browser verification:** Walk Overview, Skills, Hooks, MCP playground, Artifacts, Playground, Logs, Evals, and Comparisons against a packaged foreground server.
- [ ] **Native verification:** Run authenticated Claude/Codex spot checks only when the corresponding CLI is installed and signed in.
- [ ] **Final commit/push:** Push every focused commit and confirm the branch is clean and synchronized with origin.

## Already Resolved

- The shared streaming writer is already used by Playground routes; verify existing route-stream tests only.
- Workbench client exact-key checking is already centralized in `client-helpers.ts`; do not add another helper.
- Commit `8cbc037` already makes the production workbench build independent of ambient `NODE_ENV`.
