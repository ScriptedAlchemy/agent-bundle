# MCP conformance evidence

The MCP conformance lane is intentionally opt-in. Run it locally with:

```sh
pnpm test:mcp-conformance
```

CI exposes the same command through the manually dispatched `MCP conformance`
workflow. The lane uses one Node version and one existing fixture, and uploads
the official runner's `checks.json` artifacts from `artifacts/mcp-conformance`.
It is not part of pull request, push, scheduled, or default Rstest execution.

## Transport and fixture

Generated agent-bundle MCP artifacts are managed stdio executables; they do
not expose an HTTP transport seam. The harness therefore builds the existing
`packages/agent-bundle/fixtures/route-harness` generated-route fixture through
the public build pipeline, starts the generated stdio artifact, and forwards
raw JSON-RPC frames through the official SDK's
`NodeStreamableHTTPServerTransport`. The adapter owns only loopback transport,
health checking, bounded runner execution, and teardown. Route registration,
Flight rendering, schemas, and responses remain the generated artifact's
logic.

The copied fixture is narrowed to its MCP routes before building. Its state,
event, and CLI sources are omitted because conformance needs one generated MCP
surface and must not add the packed fixture's separate npm-install journey.

## Recorded run: 2026-09-02

- Runner: `@modelcontextprotocol/conformance@0.1.16`
- Suite: `server --suite active`
- Specification: `2025-11-25`
- Scenarios: 30 total; 7 passed, 23 expected failures, 0 skipped
- Unexpected failures: 0

The dated expected-failure baseline is
`packages/agent-bundle/tests/fixtures/mcp-conformance-expected-failures.yml`.
It records three unsupported generated-server operation families
(`completion/complete`, `logging/setLevel`, and resource subscriptions) plus
the canonical content-specific tools, resources, and prompts that the reused
route harness does not provide. The official runner rejects both unexpected
failures and stale baseline entries, so newly fixed scenarios must be removed
from the baseline.
