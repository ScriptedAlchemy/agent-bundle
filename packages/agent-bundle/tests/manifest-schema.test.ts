import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  artifactManifestSchema as apiArtifactManifestSchema,
  validateArtifactManifestSchema as apiValidateArtifactManifestSchema,
} from '../src/api.ts';
import { parseArtifactManifest, type ArtifactManifest } from '../src/build/manifest.ts';
import { artifactManifestSchema, validateArtifactManifestSchema } from '../src/build/manifest-schema.ts';
import { digest, stableJson } from '../src/core/digest.ts';
import type { JsonObject, JsonValue } from '../src/dev/types.ts';
import {
  artifactManifestSchema as publicArtifactManifestSchema,
  validateArtifactManifestSchema as publicValidateArtifactManifestSchema,
} from '../src/index.ts';

const packageRoot = join(process.cwd(), 'packages/agent-bundle');
const schemaFile = 'schemas/agent-bundle.manifest.schema.json';

const hash = (character: string): string => character.repeat(64);

const sourceInputs = [
  { path: 'agent-bundle.config.ts', sha256: hash('a') },
  { executable: true, path: 'src/review.ts', sha256: hash('b') },
] as const;

const file = (
  path: string,
  kind: ArtifactManifest['files'][number]['kind'],
  extra: Partial<Pick<ArtifactManifest['files'][number], 'mode' | 'sourceInputs'>> = {},
): ArtifactManifest['files'][number] => ({
  bytes: 64,
  kind,
  path,
  sha256: hash('c'),
  sourceInputs: ['agent-bundle.config.ts'],
  ...extra,
});

/**
 * One valid manifest that instantiates every object shape the schema
 * declares — every optional key, every conditional branch (event route, MCP
 * route kinds, generated CLI, server-scoped layout, prebuilt and built MCP
 * apps, compiled MCP server, npm distribution) — so the mutation sweep below
 * reaches every closed object.
 */
const validManifest = (): ArtifactManifest => ({
  agentSkills: {
    schemaSha256: hash('d'),
    sourceRevision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379',
    specification: 'https://raw.githubusercontent.com/agentskills/agentskills/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx',
  },
  application: { description: 'Reviews pull requests.', id: 'acme.review', name: 'Review', version: '1.2.3' },
  distribution: { channels: ['local', 'npm'], install: { instructions: 'install.md', script: 'install.sh' } },
  executables: {
    bins: [{ hosts: ['claude', 'codex'], name: 'review', path: 'runtime/bin/review.mjs', worker: 'runtime/bin/review.worker.mjs' }],
    hooks: [
      { event: 'PostToolUse', host: 'claude', id: 'post-commit', kind: 'config', name: 'Post-commit', path: 'runtime/hooks/post-commit.mjs' },
      { event: 'PreToolUse', host: 'claude', id: 'pre-commit', kind: 'event-route', name: 'Pre-commit', path: 'runtime/hooks/pre-commit.mjs', routeId: 'pre-commit', timeout: 30 },
    ],
    mcpServers: [{
      apps: [
        { id: 'dashboard', name: 'Dashboard', path: 'runtime/mcp/apps/dashboard.html', resourceUri: 'ui://review/dashboard' },
        { id: 'vendor', name: 'Vendor', prebuilt: true, resourceUri: 'ui://review/vendor' },
      ],
      entry: { path: 'runtime/mcp/review.mjs', worker: 'runtime/mcp/review.worker.mjs' },
      hosts: ['codex'],
      id: 'review',
      kind: 'compiled',
      name: 'Review',
      transport: 'stdio',
    }],
    scripts: [{
      hosts: ['claude'],
      id: 'lint',
      mode: 'bundle',
      name: 'Lint',
      path: 'runtime/scripts/lint.mjs',
      rendered: { routeId: 'lint' },
      worker: 'runtime/scripts/lint.worker.mjs',
    }],
  },
  files: [
    file('claude/hooks.json', 'generated'),
    file('claude/plugin.json', 'generated'),
    file('codex/marketplace.json', 'generated'),
    file('codex/mcp.json', 'generated'),
    file('codex/plugin.json', 'generated'),
    file('install.md', 'copy'),
    file('install.sh', 'copy', { mode: 0o755 }),
    file('runtime/bin/review.mjs', 'bundle', { mode: 0o755, sourceInputs: ['agent-bundle.config.ts', 'src/review.ts'] }),
    file('runtime/bin/review.worker.mjs', 'bundle', { sourceInputs: ['src/review.ts'] }),
    file('runtime/hooks/post-commit.mjs', 'bundle'),
    file('runtime/hooks/pre-commit.mjs', 'bundle'),
    file('runtime/mcp/apps/dashboard.html', 'bundle'),
    file('runtime/mcp/apps/vendor.html', 'prebuilt', { sourceInputs: [] }),
    file('runtime/mcp/review.mjs', 'bundle'),
    file('runtime/mcp/review.worker.mjs', 'bundle'),
    file('runtime/scripts/lint.mjs', 'bundle'),
    file('runtime/scripts/lint.worker.mjs', 'bundle'),
  ],
  manifestVersion: 2,
  producer: { name: 'agent-bundle', version: '0.1.0' },
  project: {
    configDigest: hash('a'),
    configPath: 'agent-bundle.config.ts',
    modelDigest: hash('e'),
    packageName: '@acme/review',
    packageVersion: '1.2.3',
    revision: digest({ inputs: sourceInputs }),
    sourceInputs,
  },
  projections: [
    {
      adapterRevision: 'claude-adapter-v1',
      documents: { hooks: 'claude/hooks.json', plugin: 'claude/plugin.json' },
      host: 'claude',
      observedVersion: '1.0.0',
      schemas: [{ name: 'claude-hooks', revision: 'hooks-v1', sha256: hash('f') }],
    },
    {
      adapterRevision: 'codex-adapter-v1',
      documents: { marketplace: 'codex/marketplace.json', mcp: 'codex/mcp.json', plugin: 'codex/plugin.json' },
      host: 'codex',
      marketplace: { name: 'acme' },
      observedVersion: '0.147.0',
      schemas: [],
    },
  ],
  routes: {
    cli: {
      commands: [{
        aliases: ['l', 'lt'],
        description: 'Lint the tree.',
        exitCode: 'result',
        mcp: { confirm: true, server: 'review', tool: 'review-tool' },
        options: [
          { description: 'Apply fixes.', key: 'fix', kind: 'boolean', option: '--fix', repeated: false, required: false },
          { choices: ['high', 'low'], key: 'level', kind: 'enum', option: '--level', repeated: false, required: true },
          { key: 'target', kind: 'string', option: '<target>', positional: 0, repeated: true, required: false },
        ],
        path: ['lint'],
        routeId: 'lint-cli',
      }],
      mode: 'generated',
      routes: [{ id: 'lint-cli', kind: 'cli', provenance: { kind: 'conventional' }, source: 'src/cli/lint.ts' }],
    },
    contracts: [{
      id: 'contract:src/tools/review-schema.ts#reviewInput',
      input: { additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'], type: 'object' },
      origin: { binding: 'reviewInput', module: 'src/tools/review-schema.ts' },
      routes: ['review-tool'],
    }],
    digest: hash('1'),
    events: [{ event: 'PreToolUse', id: 'pre-commit', kind: 'event-route', provenance: { kind: 'conventional' }, source: 'src/hooks/pre-commit.ts' }],
    layouts: [
      { id: 'root-layout', scope: 'root', source: 'src/layouts/root.tsx' },
      { id: 'server-layout', scope: 'server', serverId: 'review', source: 'src/layouts/server.tsx' },
    ],
    providers: [{ id: 'theme', name: 'Theme', source: 'src/providers/theme.tsx' }],
    scripts: [{ description: 'Lint the tree.', id: 'lint', kind: 'script', provenance: { kind: 'conventional' }, source: 'src/scripts/lint.ts' }],
    servers: [{
      id: 'review',
      mode: 'generated',
      name: 'Review',
      routes: [
        { id: 'dashboard', kind: 'app', provenance: { kind: 'conventional' }, serverId: 'review', source: 'src/apps/dashboard.tsx' },
        {
          contract: 'contract:src/tools/review-schema.ts#reviewInput',
          id: 'review-tool',
          inputSchema: {
            additionalProperties: false,
            properties: {
              count: { type: 'number' },
              level: { default: 'low', description: 'Severity floor.', enum: ['high', 'low'], type: 'string' },
              path: { description: 'File to review.', type: 'string' },
              strict: { default: false, type: 'boolean' },
              tags: { default: ['docs'], items: { enum: ['docs', 'tests'], type: 'string' }, type: 'array' },
              weights: { items: { type: 'number' }, type: 'array' },
            },
            required: ['path'],
            type: 'object',
          },
          kind: 'tool',
          provenance: { kind: 'conventional' },
          serverId: 'review',
          source: 'src/tools/review.ts',
        },
        { id: 'summary', kind: 'resource', provenance: { kind: 'conventional' }, serverId: 'review', source: 'src/resources/summary.ts' },
      ],
    }],
  },
  runtime: { node: '22.12.0' },
  validation: {
    artifact: { status: 'passed' },
    projections: [{ host: 'claude', status: 'passed' }, { host: 'codex', status: 'passed' }],
    source: { status: 'passed' },
  },
});

/** The smallest manifest both validators accept: no optional key, every list empty. */
const minimalManifest = (): ArtifactManifest => ({
  agentSkills: validManifest().agentSkills,
  application: { id: 'acme.empty', name: 'Empty', version: '0.0.1' },
  distribution: { channels: ['local'] },
  executables: { bins: [], hooks: [], mcpServers: [], scripts: [] },
  files: [],
  manifestVersion: 2,
  producer: { name: 'agent-bundle', version: '0.1.0' },
  project: {
    configDigest: hash('a'),
    configPath: 'agent-bundle.config.ts',
    modelDigest: hash('e'),
    revision: digest({ inputs: [sourceInputs[0]] }),
    sourceInputs: [sourceInputs[0]],
  },
  projections: [],
  routes: { digest: hash('1'), events: [], layouts: [], providers: [], scripts: [], servers: [] },
  runtime: { node: '22.12.0' },
  validation: { artifact: { status: 'passed' }, projections: [], source: { status: 'passed' } },
});

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;

type MutableManifest = Mutable<ArtifactManifest>;
type Record_ = Record<string, unknown>;

const clone = (): MutableManifest => structuredClone(validManifest()) as unknown as MutableManifest;

const canonicalBytes = (value: unknown): string => `${stableJson(value)}\n`;

const parserAccepts = (candidate: unknown): boolean => {
  try {
    parseArtifactManifest(canonicalBytes(candidate));
    return true;
  } catch {
    return false;
  }
};

const schemaAccepts = (candidate: unknown): boolean => validateArtifactManifestSchema(candidate).length === 0;

const verdict = (accepts: boolean): string => (accepts ? 'accepts' : 'rejects');

const isRecord = (value: unknown): value is Record_ =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asObject = (value: JsonValue | undefined): JsonObject => {
  if (!isRecord(value)) throw new TypeError('expected a JSON object');
  return value as JsonObject;
};

interface ObjectSite {
  readonly keys: readonly string[];
  readonly pointer: string;
  readonly segments: readonly (number | string)[];
}

/** Every plain object in a JSON value, root first, with its JSON Pointer. */
const collectObjects = (
  value: unknown,
  segments: readonly (number | string)[] = [],
  sites: ObjectSite[] = [],
): readonly ObjectSite[] => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectObjects(entry, [...segments, index], sites));
  } else if (isRecord(value)) {
    sites.push({ keys: Object.keys(value), pointer: `/${segments.join('/')}`, segments });
    for (const key of Object.keys(value)) collectObjects(value[key], [...segments, key], sites);
  }
  return sites;
};

const objectAt = (root: Record_, segments: readonly (number | string)[]): Record_ => {
  let current: unknown = root;
  for (const segment of segments) current = (current as Record<number | string, unknown>)[segment];
  if (!isRecord(current)) throw new TypeError(`no object at /${segments.join('/')}`);
  return current;
};

/** Swaps a value for one of another JSON type: strings become numbers, everything else a string. */
const retyped = (value: unknown): unknown => {
  if (typeof value === 'string') return 1;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'retyped';
};

interface Mutation {
  readonly apply: (manifest: Record_) => void;
  readonly label: string;
}

const sweepMutations = (fixture: ArtifactManifest): readonly Mutation[] => {
  const mutations: Mutation[] = [];
  for (const site of collectObjects(fixture)) {
    mutations.push({ apply: (manifest) => { objectAt(manifest, site.segments).zzz = true; }, label: `${site.pointer}: add zzz` });
    for (const key of site.keys) {
      mutations.push({ apply: (manifest) => { delete objectAt(manifest, site.segments)[key]; }, label: `${site.pointer}: delete ${key}` });
      mutations.push({
        apply: (manifest) => {
          const target = objectAt(manifest, site.segments);
          target[key] = retyped(target[key]);
        },
        label: `${site.pointer}: retype ${key}`,
      });
    }
  }
  return mutations;
};

/**
 * Sweep mutations where the parser and the schema legitimately disagree. Each
 * entry names a rule JSON Schema cannot express; the sweep asserts the parser
 * rejects and the schema accepts exactly these, so a stale entry (the schema
 * learned the rule, or the parser dropped it) fails as loudly as a new
 * disagreement anywhere else.
 */
const sweepDisagreements: ReadonlyMap<string, string> = new Map([
  [
    '/project/sourceInputs/1: delete executable',
    'project.revision is digest({ inputs: sourceInputs }), so dropping an optional executable flag changes the digest (digest cross-reference)',
  ],
  [
    '/routes/servers/0/routes/1/inputSchema/properties: delete path',
    'inputSchema.required must name declared properties (cross-reference)',
  ],
  [
    '/routes: delete contracts',
    'routes.contracts is present exactly when a route binds a contract (cross-reference)',
  ],
  [
    '/routes/servers/0/routes/1: delete contract',
    'routes.contracts[].routes are exactly the routes whose contract names them (cross-reference)',
  ],
  [
    '/routes/contracts/0/input/properties: delete path',
    'contract input.required must name declared properties (cross-reference)',
  ],
]);

/**
 * Rules only the parser enforces, one targeted mutation each: sorted arrays
 * with unique sort keys, cross-references between sections, digests, and
 * value validity beyond a grammar. The schema accepts every one of these.
 */
const parserOnlyRules: readonly { readonly apply: (manifest: MutableManifest) => void; readonly rule: string }[] = [
  // Sorted arrays with unique sort keys (JSON Schema has no ordering vocabulary; uniqueItems only sees identical items).
  { apply: (manifest) => { manifest.files.reverse(); }, rule: 'files sorted by path' },
  {
    apply: (manifest) => { manifest.files.push({ ...manifest.files[manifest.files.length - 1]!, sha256: hash('9') }); },
    rule: 'files unique by path (duplicate sort key with a distinct payload)',
  },
  { apply: (manifest) => { manifest.project.sourceInputs.reverse(); }, rule: 'project.sourceInputs sorted by path' },
  { apply: (manifest) => { manifest.files[7]!.sourceInputs.reverse(); }, rule: 'files[].sourceInputs sorted' },
  { apply: (manifest) => { manifest.projections.reverse(); }, rule: 'projections sorted by host' },
  { apply: (manifest) => { manifest.executables.hooks.reverse(); }, rule: 'executables.hooks sorted by (host, id)' },
  { apply: (manifest) => { manifest.executables.bins[0]!.hosts.reverse(); }, rule: 'hosts sorted' },
  { apply: (manifest) => { manifest.routes.servers[0]!.routes.reverse(); }, rule: 'routes.servers[].routes sorted by id' },
  { apply: (manifest) => { manifest.routes.layouts.reverse(); }, rule: 'routes.layouts sorted by id' },
  { apply: (manifest) => { manifest.routes.cli!.commands![0]!.aliases.reverse(); }, rule: 'cli command aliases sorted' },
  { apply: (manifest) => { manifest.routes.cli!.commands![0]!.options.reverse(); }, rule: 'cli command options sorted by key' },
  { apply: (manifest) => { manifest.executables.mcpServers[0]!.apps.reverse(); }, rule: 'mcpServers[].apps sorted by id' },
  { apply: (manifest) => { manifest.validation.projections.reverse(); }, rule: 'validation.projections sorted by host' },
  // Cross-references between sections.
  { apply: (manifest) => { manifest.executables.bins[0]!.hosts = ['claude', 'zed']; }, rule: 'hosts name declared projections' },
  { apply: (manifest) => { manifest.executables.hooks[1]!.host = 'zed'; }, rule: 'hooks[].host names a declared projection' },
  { apply: (manifest) => { manifest.validation.projections[1]!.host = 'cursor'; }, rule: 'validation.projections mirror projections' },
  { apply: (manifest) => { manifest.executables.bins[0]!.path = 'runtime/bin/missing.mjs'; }, rule: 'bins[].path names a manifest file' },
  { apply: (manifest) => { manifest.executables.hooks[0]!.path = 'runtime/hooks/missing.mjs'; }, rule: 'hooks[].path names a manifest file' },
  { apply: (manifest) => { manifest.executables.mcpServers[0]!.entry!.worker = 'runtime/mcp/missing.mjs'; }, rule: 'mcpServers[].entry.worker names a manifest file' },
  { apply: (manifest) => { manifest.executables.mcpServers[0]!.apps[0]!.path = 'runtime/mcp/apps/missing.html'; }, rule: 'mcpServers[].apps[].path names a manifest file' },
  { apply: (manifest) => { manifest.executables.scripts[0]!.worker = 'runtime/scripts/missing.mjs'; }, rule: 'scripts[].worker names a manifest file' },
  { apply: (manifest) => { manifest.projections[0]!.documents.plugin = 'claude/missing.json'; }, rule: 'projections[].documents.* name manifest files' },
  { apply: (manifest) => { manifest.distribution.install!.script = 'missing.sh'; }, rule: 'distribution.install.* name manifest files' },
  { apply: (manifest) => { manifest.executables.scripts[0]!.rendered!.routeId = 'nope'; }, rule: 'scripts[].rendered.routeId names a script route' },
  { apply: (manifest) => { manifest.executables.hooks[1]!.routeId = 'nope'; }, rule: 'hooks[].routeId names an event route' },
  { apply: (manifest) => { manifest.routes.cli!.commands![0]!.routeId = 'nope'; }, rule: 'routes.cli.commands[].routeId names a CLI route' },
  { apply: (manifest) => { manifest.routes.servers[0]!.routes[0]!.serverId = 'other'; }, rule: 'routes.servers[].routes[].serverId equals the server id' },
  { apply: (manifest) => { manifest.routes.layouts[1]!.serverId = 'other'; }, rule: 'routes.layouts[].serverId names a declared server' },
  { apply: (manifest) => { manifest.routes.servers[0]!.routes[1]!.contract = 'contract:nope#x'; }, rule: 'route.contract names a declared contract' },
  { apply: (manifest) => { manifest.routes.contracts![0]!.routes = ['review-tool', 'summary']; }, rule: 'contracts[].routes are exactly the routes binding the contract' },
  { apply: (manifest) => { manifest.routes.contracts![0]!.routes = ['nope']; }, rule: 'contracts[].routes name declared routes' },
  { apply: (manifest) => { manifest.files[1]!.sourceInputs = ['src/other.ts']; }, rule: 'files[].sourceInputs name project source inputs' },
  {
    apply: (manifest) => { manifest.routes.servers[0]!.routes[1]!.inputSchema!.required = ['nope']; },
    rule: 'inputSchema.required names declared properties',
  },
  // Digests.
  { apply: (manifest) => { manifest.project.configDigest = hash('9'); }, rule: 'project.configDigest equals the configPath source input hash' },
  { apply: (manifest) => { manifest.project.revision = hash('9'); }, rule: 'project.revision equals digest(sourceInputs)' },
  // Value validity beyond a grammar.
  { apply: (manifest) => { manifest.runtime.node = '18.0.0'; }, rule: 'runtime.node satisfies the generated runtime floor' },
  { apply: (manifest) => { manifest.project.packageName = 'Not A Package'; }, rule: 'project.packageName is a valid npm name' },
  { apply: (manifest) => { manifest.project.packageVersion = 'v1'; }, rule: 'project.packageVersion is a semantic version' },
];

/**
 * Parser rules the schema does encode, one value-level mutation each (the
 * sweep covers key deletion, unknown keys, and retyping). Both reject.
 */
const schemaEncodedRules: readonly { readonly apply: (manifest: MutableManifest) => void; readonly rule: string }[] = [
  { apply: (manifest) => { (manifest as Record_).manifestVersion = 1; }, rule: 'manifestVersion is 2' },
  { apply: (manifest) => { (manifest.producer as Record_).name = 'other'; }, rule: 'producer.name is agent-bundle' },
  { apply: (manifest) => { manifest.runtime.node = '22.12'; }, rule: 'runtime.node is major.minor.patch' },
  { apply: (manifest) => { manifest.runtime.node = 'v22.12.0'; }, rule: 'runtime.node has no prefix' },
  { apply: (manifest) => { manifest.runtime.node = '22.012.0'; }, rule: 'runtime.node has no leading zeros' },
  { apply: (manifest) => { manifest.agentSkills.schemaSha256 = hash('A'); }, rule: 'sha256 fields are lowercase hex' },
  { apply: (manifest) => { manifest.routes.digest = 'abc'; }, rule: 'sha256 fields are 64 characters' },
  { apply: (manifest) => { manifest.application.description = ''; }, rule: 'strings are non-empty' },
  { apply: (manifest) => { manifest.files[0]!.path = 'agent-bundle.manifest.json'; }, rule: 'files never name the manifest' },
  { apply: (manifest) => { manifest.files[0]!.path = '../escape'; }, rule: 'paths have no .. segment' },
  { apply: (manifest) => { manifest.files[0]!.path = './claude/hooks.json'; }, rule: 'paths have no . segment' },
  { apply: (manifest) => { manifest.files[0]!.path = '/claude/hooks.json'; }, rule: 'paths are relative' },
  { apply: (manifest) => { manifest.files[0]!.path = 'claude//hooks.json'; }, rule: 'paths have no empty segment' },
  { apply: (manifest) => { manifest.files[0]!.path = 'claude\\hooks.json'; }, rule: 'paths have no backslash' },
  { apply: (manifest) => { manifest.files[0]!.path = 'claude/hooks.json/'; }, rule: 'paths have no trailing slash' },
  { apply: (manifest) => { manifest.files[0]!.bytes = -1; }, rule: 'files[].bytes is non-negative' },
  { apply: (manifest) => { manifest.files[0]!.bytes = 1.5; }, rule: 'files[].bytes is an integer' },
  { apply: (manifest) => { manifest.files[6]!.mode = 0o1000; }, rule: 'files[].mode is at most 0o777' },
  { apply: (manifest) => { (manifest.files[0] as Record_).kind = 'symlink'; }, rule: 'files[].kind is a known kind' },
  { apply: (manifest) => { manifest.executables.hooks[1]!.timeout = 0; }, rule: 'hooks[].timeout is positive' },
  { apply: (manifest) => { manifest.routes.cli!.commands![0]!.options[2]!.positional = -1; }, rule: 'cli option positional is non-negative' },
  { apply: (manifest) => { manifest.routes.cli!.commands![0]!.path = []; }, rule: 'cli command path has a segment' },
  { apply: (manifest) => { manifest.executables.bins[0]!.hosts = []; }, rule: 'hosts name at least one host' },
  { apply: (manifest) => { manifest.distribution.channels = ['npm']; }, rule: 'channels include local' },
  { apply: (manifest) => { manifest.distribution.channels = ['npm', 'local']; }, rule: 'channels are sorted' },
  { apply: (manifest) => { manifest.distribution.channels = ['local', 'local']; }, rule: 'channels are unique' },
  { apply: (manifest) => { manifest.distribution.install = {}; }, rule: 'install names a pointer' },
  { apply: (manifest) => { manifest.routes.cli!.mode = 'conventional'; }, rule: 'cli commands appear only in generated mode' },
  { apply: (manifest) => { manifest.routes.cli!.routes[0]!.kind = 'script'; }, rule: 'cli routes are cli routes or projected MCP tool routes' },
  {
    apply: (manifest) => { manifest.executables.hooks[0]!.routeId = 'pre-commit'; },
    rule: 'hooks[].routeId is present exactly for event-route hooks',
  },
  { apply: (manifest) => { manifest.routes.events[0]!.kind = 'script'; }, rule: 'event routes are event-route routes' },
  { apply: (manifest) => { manifest.routes.scripts[0]!.kind = 'event-route'; }, rule: 'script routes are script routes' },
  { apply: (manifest) => { manifest.routes.servers[0]!.routes[0]!.kind = 'cli'; }, rule: 'server routes are MCP route kinds' },
  { apply: (manifest) => { manifest.routes.layouts[0]!.serverId = 'review'; }, rule: 'root layouts carry no serverId' },
  { apply: (manifest) => { manifest.executables.mcpServers[0]!.kind = 'remote'; }, rule: 'only compiled servers carry an entry' },
  { apply: (manifest) => { manifest.executables.mcpServers[0]!.apps[1]!.path = 'runtime/mcp/apps/vendor.html'; }, rule: 'prebuilt apps carry no path' },
  { apply: (manifest) => { (manifest.validation.artifact as Record_).status = 'failed'; }, rule: 'validation status is passed' },
  { apply: (manifest) => { (manifest.routes.servers[0]!.routes[1]!.inputSchema as Record_).additionalProperties = true; }, rule: 'inputSchema is closed' },
  { apply: (manifest) => { (manifest.routes.servers[0]!.routes[1]!.inputSchema as Record_).type = 'array'; }, rule: 'inputSchema is an object schema' },
  {
    apply: (manifest) => { (manifest.routes.servers[0]!.routes[1]!.inputSchema!.properties.count as Record_).type = 'integer'; },
    rule: 'inputSchema properties use the bounded scalar types',
  },
  {
    apply: (manifest) => { (manifest.routes.servers[0]!.routes[1]!.inputSchema!.properties.count as Record_).enum = ['1']; },
    rule: 'only string properties carry enum',
  },
  {
    apply: (manifest) => { (manifest.routes.servers[0]!.routes[1]!.inputSchema!.properties.weights as Record_).items = { enum: ['1'], type: 'number' }; },
    rule: 'only string array items carry enum',
  },
  {
    apply: (manifest) => { (manifest.routes.servers[0]!.routes[1]!.inputSchema!.properties.level as Record_).enum = ['']; },
    rule: 'enum entries are non-empty strings',
  },
  {
    apply: (manifest) => { (manifest.routes.servers[0]!.routes[1]!.inputSchema!.properties.strict as Record_).default = null; },
    rule: 'defaults are scalar literals or flat arrays of them',
  },
  {
    apply: (manifest) => { (manifest.routes.servers[0]!.routes[1]!.inputSchema!.properties.tags as Record_).default = [{}]; },
    rule: 'array defaults hold scalar literals',
  },
];

it('accepts a fully populated and a minimal hand-built manifest in both the parser and the schema', () => {
  for (const manifest of [validManifest(), minimalManifest()]) {
    expect(parseArtifactManifest(canonicalBytes(manifest))).toEqual(manifest);
    expect(validateArtifactManifestSchema(manifest)).toEqual([]);
  }
});

it('agrees with the parser on every delete, unknown-key, and retype mutation, except the documented allowlist', () => {
  const fixture = validManifest();
  const mutations = sweepMutations(fixture);
  const disagreements: string[] = [];
  const accepted: string[] = [];
  const allowlistHits = new Set<string>();

  for (const mutation of mutations) {
    const candidate = structuredClone(fixture) as unknown as Record_;
    mutation.apply(candidate);
    const parser = parserAccepts(candidate);
    const schema = schemaAccepts(candidate);
    if (sweepDisagreements.has(mutation.label)) {
      allowlistHits.add(mutation.label);
      expect([mutation.label, verdict(parser), verdict(schema)]).toEqual([mutation.label, 'rejects', 'accepts']);
      continue;
    }
    if (parser && schema) accepted.push(mutation.label);
    if (parser !== schema) disagreements.push(`${mutation.label}: parser ${verdict(parser)}, schema ${verdict(schema)}`);
  }

  expect(disagreements).toEqual([]);
  expect([...allowlistHits].sort()).toEqual([...sweepDisagreements.keys()].sort());
  // The sweep reaches the deepest objects, and both validators accept the legitimate optional-key and literal mutations.
  const pointers = new Set(collectObjects(fixture).map((site) => site.pointer));
  expect(pointers).toContain('/routes/servers/0/routes/1/inputSchema/properties/tags/items');
  expect(pointers).toContain('/routes/cli/commands/0/mcp');
  expect(pointers).toContain('/executables/mcpServers/0/entry');
  expect(pointers.size).toBeGreaterThan(60);
  expect(accepted).toEqual(expect.arrayContaining([
    '/application: delete description',
    '/distribution: delete install',
    '/executables/hooks/1: delete timeout',
    '/executables/mcpServers/0/entry: delete worker',
    '/executables/scripts/0: delete rendered',
    '/project: delete packageVersion',
    '/projections/1: delete marketplace',
    '/routes: delete cli',
    '/routes/cli/commands/0: delete mcp',
    '/routes/cli/commands/0/options/2: delete positional',
    '/routes/servers/0/routes/1: delete inputSchema',
    '/routes/servers/0/routes/1/inputSchema: delete required',
    '/routes/servers/0/routes/1/inputSchema/properties/level: retype default',
    '/routes/servers/0/routes/1/inputSchema/properties/strict: retype default',
    '/routes/servers/0/routes/1/inputSchema/properties/tags: retype default',
  ]));
  // Every mutation that names a required key, an unknown key, or a retyped scalar is rejected by both.
  expect(accepted).not.toContain('/: delete files');
  expect(accepted).not.toContain('/routes/servers/0/routes/1/provenance: add zzz');
  expect(accepted).not.toContain('/files/0: retype bytes');
});

it('leaves sorted arrays, cross-references, digests, and value validity to the parser', () => {
  const outcomes = parserOnlyRules.map(({ apply, rule }) => {
    const manifest = clone();
    apply(manifest);
    return { parser: verdict(parserAccepts(manifest)), rule, schema: verdict(schemaAccepts(manifest)) };
  });
  expect(outcomes).toEqual(parserOnlyRules.map(({ rule }) => ({ parser: 'rejects', rule, schema: 'accepts' })));
  expect(new Set(parserOnlyRules.map(({ rule }) => rule)).size).toBe(parserOnlyRules.length);
});

it('encodes the parser rules a schema can state, so both reject the same values', () => {
  const outcomes = schemaEncodedRules.map(({ apply, rule }) => {
    const manifest = clone();
    apply(manifest);
    return { parser: verdict(parserAccepts(manifest)), rule, schema: verdict(schemaAccepts(manifest)) };
  });
  expect(outcomes).toEqual(schemaEncodedRules.map(({ rule }) => ({ parser: 'rejects', rule, schema: 'rejects' })));
});

it('reports closed-key, required-key, and type failures as formatted lines in deterministic order', () => {
  const root = clone() as unknown as Record_;
  root.zzz = true;
  expect(validateArtifactManifestSchema(root)).toEqual(['/ must NOT have additional properties: zzz']);

  const nested = clone();
  (nested.routes.servers[0]!.routes[1]!.provenance as Record_).zzz = 1;
  (nested.executables.mcpServers[0]!.apps[1] as Record_).zzz = 1;
  expect(validateArtifactManifestSchema(nested)).toEqual([
    '/executables/mcpServers/0/apps/1 must NOT have additional properties: zzz',
    '/routes/servers/0/routes/1/provenance must NOT have additional properties: zzz',
  ]);

  const missing = clone() as unknown as Record_;
  delete missing.files;
  expect(validateArtifactManifestSchema(missing)).toEqual(["/ must have required property 'files'"]);

  expect(validateArtifactManifestSchema('not a manifest')).toEqual(['/ must be object']);
  expect(Object.isFrozen(validateArtifactManifestSchema(missing))).toBe(true);
  expect(Object.isFrozen(validateArtifactManifestSchema(validManifest()))).toBe(true);
});

it('leaves byte-level rules to the parser: a parsed value carries no formatting or duplicate keys', () => {
  const pretty = `${JSON.stringify(validManifest(), null, 2)}\n`;
  expect(() => parseArtifactManifest(pretty)).toThrow(/canonical/u);
  expect(validateArtifactManifestSchema(JSON.parse(pretty))).toEqual([]);
});

it('publishes a deep-frozen draft 2020-12 schema pinned to manifestVersion 2 that matches the shipped file', async () => {
  expect(artifactManifestSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(artifactManifestSchema.$id).toBe('https://scriptedalchemy.github.io/agent-bundle/schemas/agent-bundle.manifest.schema.json');
  expect(artifactManifestSchema.type).toBe('object');
  expect(artifactManifestSchema.additionalProperties).toBe(false);
  expect(artifactManifestSchema.required).toEqual(Object.keys(minimalManifest()).sort());
  const properties = asObject(artifactManifestSchema.properties);
  expect(Object.keys(properties)).toEqual(Object.keys(minimalManifest()).sort());
  expect(asObject(properties.manifestVersion).const).toBe(2);

  expect(Object.isFrozen(artifactManifestSchema)).toBe(true);
  expect(Object.isFrozen(properties)).toBe(true);
  const definitions = asObject(artifactManifestSchema.$defs);
  expect(Object.isFrozen(definitions)).toBe(true);
  expect(Object.isFrozen(asObject(asObject(definitions.route).properties).kind)).toBe(true);
  expect(asObject(asObject(definitions.route).properties).kind).toEqual({
    enum: ['app', 'cli', 'event-route', 'prompt', 'resource', 'script', 'tool'],
  });

  const shipped: unknown = JSON.parse(await readFile(join(packageRoot, schemaFile), 'utf8'));
  expect(artifactManifestSchema).toEqual(shipped);
});

it('ships the schema file through package.json files and exports', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    readonly exports: Readonly<Record<string, unknown>>;
    readonly files: readonly string[];
  };
  expect(manifest.files).toContain('schemas');
  expect(manifest.exports[`./${schemaFile}`]).toBe(`./${schemaFile}`);
});

it('exports the schema and validator from both public entry points', () => {
  expect(apiArtifactManifestSchema).toBe(artifactManifestSchema);
  expect(publicArtifactManifestSchema).toBe(artifactManifestSchema);
  expect(apiValidateArtifactManifestSchema).toBe(validateArtifactManifestSchema);
  expect(publicValidateArtifactManifestSchema).toBe(validateArtifactManifestSchema);
});
