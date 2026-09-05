# W4 — Simplified Chinese documentation

## Files

- Updated `website/docs/zh/guide/development/workbench.mdx`.
- Updated `website/docs/zh/guide/development/testing.mdx`.
- Updated `website/docs/zh/examples/audiobook-curator.mdx`.
- Updated `website/docs/zh/examples/hooks-and-scripts.mdx`.
- Updated `website/docs/zh/examples/mcp-app.mdx`.
- Added `website/docs/zh/reference/dev-server-http.mdx`.
- Updated `website/docs/zh/reference/index.mdx`.
- Updated `website/docs/zh/reference/runtime-environment.mdx`.
- Updated `website/docs/zh/reference/_meta.json`.

## Behavior documented

- Mirrored T8's unified Trace timeline, grouping, filters, deep links, route-opening flow, Raw logs decision, HTTP contracts, and host hook receipt security in Simplified Chinese.
- Added browser acceptance guidance and updated the three example walkthroughs.
- Added the development-server HTTP reference and navigation entry.
- Documented `AGENT_BUNDLE_DEV_TRACE_URL` and `AGENT_BUNDLE_DEV_TRACE_TOKEN`.

## English factual fixes

- None. The English pages do not name the browser decoder diagnostic, so no `AB8249` → `AB8243` correction was needed.

## Source verification

- `packages/agent-bundle/src/dev/trace/trace-routes.ts` proves the replay and NDJSON routes and `AB8240`–`AB8242`.
- `packages/agent-bundle/src/dev/hooks/hook-receipt-endpoint.ts` and `packages/agent-bundle/src/events/trace-receipt.ts` prove the receipt route, `AB8247`–`AB8249`, environment variables, endpoint record, size bound, and security behavior.
- `packages/workbench/src/logs/logs-page.tsx` proves `/trace?correlation=<id>` and correlation precedence.

## Verification

- `pnpm install --frozen-lockfile --prefer-offline && pnpm build` passed.
- `pnpm build && pnpm docs:site:build` passed.
- Locale drift: 0 failures across 35 page pairs and 10 meta files.
- Built links: 0 broken links across 27,147 anchors.

## Open risks

- None.
