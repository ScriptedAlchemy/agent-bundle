# Lane A6 notes

## What changed

- Replaced the route invocation request's top-level `mode`, `args`, and `event` fields with the
  discriminated `surface` union.
- Kept `routeId` as the canonical operation id and recorded the resolved surface on every
  successful or failed invocation and summary.
- Routed a tool's CLI surface through the published generated bin's existing
  `prepareRouteInvocation(routeId, argv)` export after validating the selected manifest command.
  Confirmation, projection defaults, `mapInput`, and canonical schema validation remain owned by
  that generated entry path.
- Kept projected tools as one Application tree leaf, attached their manifest command to that leaf,
  and added the MCP / projected CLI / Unit render selector, argv projection, event host/fixture
  surface input, and operation-plus-surface header.
- Updated browser decoding, runtime-backend envelopes, callers, English and Chinese Workbench
  docs, diagnostics, and the existing PR changeset.

## Request and response shape

Before:

```ts
{
  routeId: string;
  input?: JsonValue;
  args?: readonly string[];
  event?: { host?: 'claude' | 'codex' | 'cursor'; fixtureId?: string };
  mode?: 'production' | 'unit-render';
}
```

After:

```ts
{
  routeId: string;
  input?: JsonValue;
  surface?:
    | { kind: 'mcp' }
    | { kind: 'cli'; command: string; args: readonly string[] }
    | { kind: 'event'; host?: 'claude' | 'codex' | 'cursor'; fixtureId?: string }
    | { kind: 'script' }
    | { kind: 'unit-render' };
}
```

Every result/summary now has required `surface: RouteInvocationSurface`, resolved from the route
kind when omitted. Defaults are MCP for tool/resource/prompt, event for event routes, script for
scripts, and the compiled command with empty argv for standalone CLI routes. Unit render is never
a default.

## Diagnostics allocated

- `AB8253`: selected CLI command does not project onto the canonical operation.
- `AB8254`: a projected `cli:<command>` id was submitted instead of the canonical `tool:` id and
  CLI surface.

A7 may allocate in the same range; renumber these two during integration if needed.

## Tests

- Strict request-union parsing and rejection of legacy fields.
- Resolved default MCP surface and explicit unit-render surface recording.
- Generated projected-CLI parity (`mapInput` result equals generated CLI output).
- Projected CLI result projection, mismatched command `400 AB8253`, and duplicate projected
  `cli:` operation `400 AB8254`.
- Application-tree command attachment without a duplicate CLI leaf.
- Workbench selector/header and event host/fixture request shape.
- Browser decoder and all typed request/result fixtures updated.

## Decisions / ambiguity

- `surface.command` uses the manifest command path joined with spaces (the same display and
  invocation value used by the generated CLI request context). A duplicate CLI route id uses the
  path joined with `/`, matching standalone `cli:<path>` ids.
- CLI surface selection is permitted only for standalone CLI routes or explicit tool projections;
  bulk MCP command generation is not treated as the tool's selectable projected CLI surface.
- Explicit unit render remains available for component routes but is rejected for scripts, which
  have no isolated component render path.
