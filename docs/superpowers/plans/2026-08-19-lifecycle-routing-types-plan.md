# Lifecycle, Routing, and Type Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicated exact-key and shutdown mechanics, eliminate unsafe type escapes, and give project HTTP/SSE routes a dedicated owner.

**Architecture:** Small generic helpers live in core/dev utility modules; domain error classes remain in their owners. Agent API registration becomes schema-coupled, and project routes follow the same delegated route-module pattern as every other route group.

**Tech Stack:** TypeScript generics, MCP server SDK, Node HTTP, Rstest.

## Global Constraints

- Preserve all tool names, schemas, route paths, status codes, and close-error classes.
- Preserve close failure ordering.
- Do not add `any`, `unknown` casts, or new `as never`.
- Keep route dispatch exhaustive.
- Do not duplicate workbench `hasAllowedKeys`/`exactKeys`; they are already canonical.
- Verify the existing shared route-stream writer; do not rewrite it.

---

### Task 1: Consolidate backend exact-key checking

**Files:**
- Modify: `packages/agent-bundle/src/core/strict-json.ts`
- Modify: `packages/agent-bundle/src/dev/epoch-store.ts`
- Modify: `packages/agent-bundle/src/services/playground-service.ts`
- Test: `packages/agent-bundle/tests/strict-json.test.ts`
- Test: `packages/agent-bundle/tests/epoch-store.test.ts`
- Test: `packages/agent-bundle/tests/playground-service.test.ts`

**Interfaces:**
- Produces:

```ts
export const hasExactOwnKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean;
```

- [ ] **Step 1: Add failing core tests**

```ts
expect(hasExactOwnKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
expect(hasExactOwnKeys({ a: 1, b: 2 }, ['a'])).toBe(false);
expect(hasExactOwnKeys(Object.assign(Object.create(null), { a: 1 }), ['a'])).toBe(true);
expect(hasExactOwnKeys({ a: 1 }, ['a', 'a'])).toBe(false);
```

- [ ] **Step 2: Verify RED**

Expected: import fails because core does not export the helper.

- [ ] **Step 3: Implement once and remove local copies**

```ts
export const hasExactOwnKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean => {
  if (new Set(expected).size !== expected.length) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key));
};
```

- [ ] **Step 4: Run tests and commit**

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/strict-json.test.ts \
  packages/agent-bundle/tests/epoch-store.test.ts \
  packages/agent-bundle/tests/playground-service.test.ts
git add packages/agent-bundle/src packages/agent-bundle/tests
git commit -m "refactor(core): share exact object-key validation"
```

### Task 2: Remove normalized-config casting

**Files:**
- Modify: `packages/agent-bundle/src/dev/workbench-server.ts`
- Test: `packages/agent-bundle/tests/dev-workbench.test.ts`

**Interfaces:**
- `agentApiEnabledFromConfig` narrows raw config without a cast
- Removes `agentApiEnabledFromConfig` cast

- [ ] **Step 1: Add failing raw-config boundary tests**

```ts
await expect(startDevServer({ root: projectWithConfig({
  dev: { agentApi: 'yes' },
}) })).rejects.toThrow('Configuration field "dev.agentApi" must be a boolean');
```

- [ ] **Step 2: Verify RED**

Expected: the source-quality assertion still finds
`(dev as AgentBundleDevConfig).agentApi`.

- [ ] **Step 3: Narrow the raw boundary directly**

Import `isRecord` from core strict-json and replace the cast:

```ts
const dev = config.dev;
if (dev === undefined) return false;
if (!isRecord(dev)) {
  throw new TypeError('Configuration field "dev" must be an object when provided.');
}
const agentApi = dev.agentApi;
if (agentApi !== undefined && typeof agentApi !== 'boolean') {
  throw new TypeError('Configuration field "dev.agentApi" must be a boolean when provided.');
}
return agentApi === true;
```

- [ ] **Step 4: Run tests and commit**

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/dev-workbench.test.ts
git add packages/agent-bundle/src/dev/workbench-server.ts \
  packages/agent-bundle/tests/dev-workbench.test.ts
git commit -m "refactor(config): narrow Agent API enablement without casts"
```

### Task 3: Type Agent API tool registration

**Files:**
- Modify: `packages/agent-bundle/src/dev/agent-api.ts`
- Test: `packages/agent-bundle/tests/agent-api.test.ts`

**Interfaces:**
- Removes all thirteen handler `as never` casts
- Produces one adapter for the SDK's runtime `JsonSchemaType`

- [ ] **Step 1: Add registration completeness and source-quality tests**

```ts
expect(server.listToolNames()).toEqual(agentApiToolNames);
const source = await readFile(agentApiSourcePath, 'utf8');
expect(source).not.toContain('tools.project_status as never');
expect(source.match(/as never/gu) ?? []).toHaveLength(1);
```

- [ ] **Step 2: Verify RED**

Expected: source-quality assertion reports thirteen `as never` casts.

- [ ] **Step 3: Implement typed definitions**

The MCP SDK receives runtime JSON schemas produced by `fromJsonSchema`, so
TypeScript cannot infer a distinct static input type from each schema. Keep the
existing safe `unknown` input boundary and isolate the SDK compatibility cast
inside one adapter:

```ts
interface AgentToolDefinition {
  readonly name: AgentApiToolName;
  readonly inputSchema: JsonSchemaType;
  readonly handler: AgentApiToolHandler;
}

const registerAgentTool = (
  server: McpServer,
  definition: AgentToolDefinition,
): void => {
  server.registerTool(
    definition.name,
    { inputSchema: definition.inputSchema },
    definition.handler as never,
  );
};
```

Add one comment at the cast explaining that `JsonSchemaType` is runtime-only
and handlers validate `unknown` with the existing argument decoders. Define an
ordered tuple from `agentApiToolNames`, schemas, and handlers, and register it
with `registerAgentTool`. The source test permits exactly the one documented
adapter cast and rejects casts on individual handlers.

- [ ] **Step 4: Run tests, lint, and typecheck**

```sh
npx rstest --config rstest.config.ts packages/agent-bundle/tests/agent-api.test.ts
npm run typecheck
npm run lint
```

Expected: PASS and zero `as never` in Agent API registration.

- [ ] **Step 5: Commit**

```sh
git add packages/agent-bundle/src/dev/agent-api.ts \
  packages/agent-bundle/tests/agent-api.test.ts
git commit -m "refactor(agent-api): couple tool schemas to handlers"
```

### Task 4: Centralize ordered close-failure collection

**Files:**
- Create: `packages/agent-bundle/src/core/settled-failures.ts`
- Create: `packages/agent-bundle/tests/settled-failures.test.ts`
- Modify: `packages/agent-bundle/src/dev/workbench-server.ts`
- Modify: `packages/agent-bundle/src/dev/foreground-server.ts`
- Modify: `packages/agent-bundle/src/dev/mcp-app-binding-service.ts`
- Modify: `packages/agent-bundle/src/dev/mcp-session-service.ts`
- Modify: `packages/agent-bundle/src/dev/agent-api.ts`
- Modify: `packages/agent-bundle/src/services/playground-service.ts`

**Interfaces:**
- Produces:

```ts
export interface LabeledFailure<Label extends string> {
  readonly resource: Label;
  readonly error: unknown;
}

export const collectSettledFailures = <Label extends string>(
  labels: readonly Label[],
  results: readonly PromiseSettledResult<unknown>[],
): readonly LabeledFailure<Label>[];
```

- [ ] **Step 1: Add failing ordering tests**

```ts
const results = await Promise.allSettled([
  Promise.reject(first),
  Promise.resolve(),
  Promise.reject(third),
]);
expect(collectSettledFailures(['logs', 'mcp', 'playground'], results)).toEqual([
  { resource: 'logs', error: first },
  { resource: 'playground', error: third },
]);
```

Also assert a label/result length mismatch throws a programmer `TypeError`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement and migrate one owner at a time**

Each close method:

```ts
const results = await Promise.allSettled(operations);
const failures = collectSettledFailures(labels, results);
if (failures.length > 0) throw new ExistingDomainCloseError(failures);
```

Retain `DevServerLifecycleCloseError`, `McpAppLifecycleCloseError`,
`ForegroundServerCloseError`, `PlaygroundServiceCloseError`, and
`AgentApiCloseError`.

- [ ] **Step 4: Run affected tests**

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/settled-failures.test.ts \
  packages/agent-bundle/tests/playground-service.test.ts \
  packages/agent-bundle/tests/mcp-session-service.test.ts \
  packages/agent-bundle/tests/hook-playground-routes.test.ts \
  packages/agent-bundle/tests/agent-api.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add packages/agent-bundle/src packages/agent-bundle/tests
git commit -m "refactor(lifecycle): share ordered close failure collection"
```

### Task 5: Extract project routes

**Files:**
- Create: `packages/agent-bundle/src/dev/project-routes.ts`
- Create: `packages/agent-bundle/tests/project-routes.test.ts`
- Modify: `packages/agent-bundle/src/dev/foreground-server.ts`
- Modify: `packages/agent-bundle/src/dev/index.ts` only if the established route export pattern requires it

**Interfaces:**
- Produces:

```ts
export interface ProjectRouteCoordinator {
  rebuild(invalidation: Invalidation): Promise<void>;
  status(): ProjectStatus;
}

export interface ProjectRoutesOptions {
  readonly coordinator: ProjectRouteCoordinator;
  readonly eventHub: ProjectEventHub;
  readonly instanceId: string;
  readonly now: () => Date;
  readonly origin: string;
  readonly sessionToken: string;
}

export interface ProjectRoutes {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
}

export const createProjectRoutes: (
  options: ProjectRoutesOptions,
) => ProjectRoutes;
```

- [ ] **Step 1: Add failing route-module tests**

Cover status, rebuild, malformed payload, unsupported method, project SSE
subscription, disconnect cleanup, and close.

```ts
expect(await routes.handle(statusRequest, response)).toBe(true);
expect(response.statusCode).toBe(200);
expect(JSON.parse(response.body)).toEqual(coordinator.status());
```

- [ ] **Step 2: Verify RED**

Expected: `project-routes.ts` does not exist.

- [ ] **Step 3: Move route ownership without changing paths**

Move only project status/rebuild/SSE request parsing and response writing.
`ForegroundServer.#handle` keeps the flat delegated form:

```ts
if (await projectRoutes.handle(request, response)) return;
if (await skillRoutes.handle(request, response)) return;
// existing delegated route groups
await serveWorkbenchAsset(request, response);
```

Add the project route close operation to the existing ordered shutdown list.

- [ ] **Step 4: Run tests**

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/project-routes.test.ts \
  packages/agent-bundle/tests/dev-services.test.ts \
  packages/agent-bundle/tests/foreground-server.test.ts
```

- [ ] **Step 5: Verify existing stream writer**

```sh
npx rstest --config rstest.config.ts \
  packages/agent-bundle/tests/route-streams.test.ts \
  packages/agent-bundle/tests/eval-routes.test.ts
```

No source change is expected for this already-resolved finding.

- [ ] **Step 6: Commit**

```sh
git add packages/agent-bundle/src/dev/project-routes.ts \
  packages/agent-bundle/src/dev/foreground-server.ts \
  packages/agent-bundle/tests/project-routes.test.ts
git commit -m "refactor(dev): give project routes a dedicated owner"
```
