import type { SkillDocument } from '../config/skill.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { deepFreeze } from '../core/freeze.ts';
import type {
  ClaudeSkillExtension,
  CodexSkillExtension,
  CursorSkillExtension,
  PortableSkillMetadata,
  SkillIr,
  SkillIrExtensions,
  SkillIrPlaceholder,
  SkillSidecarRef,
} from './ir.ts';
import { findSkillTokens } from './tokens.ts';

const portableKeys = new Set(['allowed-tools', 'compatibility', 'description', 'license', 'metadata', 'name']);
const claudeOnlyKeys = new Set([
  'agent',
  'argument-hint',
  'arguments',
  'background',
  'context',
  'disallowed-tools',
  'effort',
  'hooks',
  'model',
  'shell',
  'user-invocable',
  'when_to_use',
]);
const sharedKeys = new Set(['disable-model-invocation', 'paths']);
const cursorOnlyKeys = new Set(['color', 'globs', 'icon']);
const authoringKeys = new Set(['targets']);
const claudeTargetKeys = new Set([
  ...claudeOnlyKeys,
  ...sharedKeys,
  'allowed-tools',
  'allowedTools',
  'argumentHint',
  'disableModelInvocation',
  'disallowedTools',
  'userInvocable',
  'whenToUse',
]);
const cursorTargetKeys = new Set([
  ...cursorOnlyKeys,
  ...sharedKeys,
  'disableModelInvocation',
]);
const codexTargetKeys = new Set(['dependencies', 'interface', 'policy']);
const codexInterfaceKeys = new Set([
  'brandColor',
  'brand_color',
  'defaultPrompt',
  'default_prompt',
  'displayName',
  'display_name',
  'iconLarge',
  'icon_large',
  'iconSmall',
  'icon_small',
  'shortDescription',
  'short_description',
]);
const codexPolicyKeys = new Set(['allowImplicitInvocation', 'allow_implicit_invocation']);
const codexDependenciesKeys = new Set(['tools']);
const codexToolKeys = new Set(['description', 'transport', 'type', 'url', 'value']);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asStringList = (value: unknown): readonly string[] | undefined => {
  if (typeof value === 'string') {
    return Object.freeze(value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0));
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return Object.freeze([...value]);
  }
  return undefined;
};

const asStringOrList = (value: unknown): string | readonly string[] | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return Object.freeze([...value]);
  return undefined;
};

const metadataRecord = (value: unknown): Readonly<Record<string, string>> | undefined => {
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
};

const portableFrom = (frontmatter: Readonly<Record<string, unknown>>): PortableSkillMetadata => {
  const allowedTools = frontmatter['allowed-tools'];
  const allowedToolList = typeof allowedTools === 'string' ? undefined : asStringList(allowedTools);
  const portable: PortableSkillMetadata = {
    ...(typeof allowedTools === 'string' ? { allowedTools } : {}),
    ...(allowedToolList === undefined ? {} : { allowedTools: allowedToolList.join(' ') }),
    ...(asString(frontmatter.compatibility) === undefined ? {} : { compatibility: asString(frontmatter.compatibility) }),
    ...(asString(frontmatter.description) === undefined ? {} : { description: asString(frontmatter.description) }),
    ...(asString(frontmatter.license) === undefined ? {} : { license: asString(frontmatter.license) }),
    ...(metadataRecord(frontmatter.metadata) === undefined ? {} : { metadata: metadataRecord(frontmatter.metadata) }),
    ...(asString(frontmatter.name) === undefined ? {} : { name: asString(frontmatter.name) }),
  };
  return Object.freeze(portable);
};

const claudeFrom = (fields: Readonly<Record<string, unknown>>): ClaudeSkillExtension | undefined => {
  const extension: ClaudeSkillExtension = {
    ...(asString(fields.agent) === undefined ? {} : { agent: asString(fields.agent) }),
    ...(asStringOrList(fields['allowed-tools']) === undefined
      ? {}
      : { allowedTools: asStringOrList(fields['allowed-tools']) }),
    ...(asString(fields['argument-hint']) === undefined ? {} : { argumentHint: asString(fields['argument-hint']) }),
    ...(asStringList(fields.arguments) === undefined ? {} : { arguments: asStringList(fields.arguments) }),
    ...(asBoolean(fields.background) === undefined ? {} : { background: asBoolean(fields.background) }),
    ...(fields.context === 'fork' ? { context: 'fork' as const } : {}),
    ...(asBoolean(fields['disable-model-invocation']) === undefined
      ? {}
      : { disableModelInvocation: asBoolean(fields['disable-model-invocation']) }),
    ...(asStringOrList(fields['disallowed-tools']) === undefined
      ? {}
      : { disallowedTools: asStringOrList(fields['disallowed-tools']) }),
    ...(fields.effort === 'low' || fields.effort === 'medium' || fields.effort === 'high'
      || fields.effort === 'xhigh' || fields.effort === 'max'
      ? { effort: fields.effort }
      : {}),
    ...(isPlainRecord(fields.hooks) ? { hooks: Object.freeze({ ...fields.hooks }) } : {}),
    ...(asString(fields.model) === undefined ? {} : { model: asString(fields.model) }),
    ...(asStringList(fields.paths) === undefined ? {} : { paths: asStringList(fields.paths) }),
    ...(fields.shell === 'bash' || fields.shell === 'powershell' ? { shell: fields.shell } : {}),
    ...(asBoolean(fields['user-invocable']) === undefined ? {} : { userInvocable: asBoolean(fields['user-invocable']) }),
    ...(asString(fields.when_to_use) === undefined ? {} : { whenToUse: asString(fields.when_to_use) }),
  };
  return Object.keys(extension).length === 0 ? undefined : Object.freeze(extension);
};

const cursorFrom = (fields: Readonly<Record<string, unknown>>): CursorSkillExtension | undefined => {
  const extension: CursorSkillExtension = {
    ...(asString(fields.color) === undefined ? {} : { color: asString(fields.color) }),
    ...(asBoolean(fields['disable-model-invocation']) === undefined
      ? {}
      : { disableModelInvocation: asBoolean(fields['disable-model-invocation']) }),
    ...(asStringOrList(fields.globs) === undefined ? {} : { globs: asStringOrList(fields.globs) }),
    ...(asString(fields.icon) === undefined ? {} : { icon: asString(fields.icon) }),
    ...(asStringList(fields.paths) === undefined ? {} : { paths: asStringList(fields.paths) }),
  };
  return Object.keys(extension).length === 0 ? undefined : Object.freeze(extension);
};

const pickString = (record: Readonly<Record<string, unknown>>, camel: string, snake: string): string | undefined =>
  asString(record[camel]) ?? asString(record[snake]);

const pickBoolean = (record: Readonly<Record<string, unknown>>, camel: string, snake: string): boolean | undefined =>
  asBoolean(record[camel]) ?? asBoolean(record[snake]);

const codexFrom = (value: unknown): CodexSkillExtension | undefined => {
  if (!isPlainRecord(value)) return undefined;
  const iface = isPlainRecord(value.interface) ? value.interface : undefined;
  const policy = isPlainRecord(value.policy) ? value.policy : undefined;
  const dependencies = isPlainRecord(value.dependencies) ? value.dependencies : undefined;
  const tools = Array.isArray(dependencies?.tools)
    ? dependencies.tools.filter(isPlainRecord).map((tool) => Object.freeze({
      ...(asString(tool.description) === undefined ? {} : { description: asString(tool.description) }),
      ...(asString(tool.transport) === undefined ? {} : { transport: asString(tool.transport) }),
      ...(asString(tool.type) === undefined ? {} : { type: asString(tool.type) }),
      ...(asString(tool.url) === undefined ? {} : { url: asString(tool.url) }),
      ...(asString(tool.value) === undefined ? {} : { value: asString(tool.value) }),
    }))
    : undefined;
  const extension: CodexSkillExtension = {
    ...(iface === undefined ? {} : {
      interface: Object.freeze({
        ...(pickString(iface, 'brandColor', 'brand_color') === undefined
          ? {}
          : { brandColor: pickString(iface, 'brandColor', 'brand_color') }),
        ...(pickString(iface, 'defaultPrompt', 'default_prompt') === undefined
          ? {}
          : { defaultPrompt: pickString(iface, 'defaultPrompt', 'default_prompt') }),
        ...(pickString(iface, 'displayName', 'display_name') === undefined
          ? {}
          : { displayName: pickString(iface, 'displayName', 'display_name') }),
        ...(pickString(iface, 'iconLarge', 'icon_large') === undefined
          ? {}
          : { iconLarge: pickString(iface, 'iconLarge', 'icon_large') }),
        ...(pickString(iface, 'iconSmall', 'icon_small') === undefined
          ? {}
          : { iconSmall: pickString(iface, 'iconSmall', 'icon_small') }),
        ...(pickString(iface, 'shortDescription', 'short_description') === undefined
          ? {}
          : { shortDescription: pickString(iface, 'shortDescription', 'short_description') }),
      }),
    }),
    ...(policy === undefined ? {} : {
      policy: Object.freeze({
        ...(pickBoolean(policy, 'allowImplicitInvocation', 'allow_implicit_invocation') === undefined
          ? {}
          : { allowImplicitInvocation: pickBoolean(policy, 'allowImplicitInvocation', 'allow_implicit_invocation') }),
      }),
    }),
    ...(tools === undefined ? {} : { dependencies: deepFreeze({ tools: tools }) }),
  };
  return Object.keys(extension).length === 0 ? undefined : Object.freeze(extension);
};

const mergeClaude = (
  left: ClaudeSkillExtension | undefined,
  right: ClaudeSkillExtension | undefined,
): ClaudeSkillExtension | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Object.freeze({ ...left, ...right });
};

const mergeCursor = (
  left: CursorSkillExtension | undefined,
  right: CursorSkillExtension | undefined,
): CursorSkillExtension | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Object.freeze({ ...left, ...right });
};

const unknownField = (source: string, field: string): Diagnostic => ({
  code: 'AB3006',
  message: `Skill frontmatter field ${JSON.stringify(field)} is not a portable Agent Skills field or a typed host extension.`,
  recovery: 'Move host-only fields into `targets.<host>` or a documented host key, or remove the unknown field.',
  severity: 'error',
  sourcePath: source,
});

const reportUnknownFields = (
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  prefix: string,
  source: string,
  diagnostics: Diagnostic[],
): void => {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) diagnostics.push(unknownField(source, `${prefix}.${key}`));
  }
};

const sidecarFromResource = (document: SkillDocument): SkillSidecarRef | undefined => {
  const resource = document.resources.find((entry) => entry.relativePath === 'agents/openai.yaml');
  if (resource === undefined) return undefined;
  return Object.freeze({
    relativePath: resource.relativePath,
    source: resource.source,
  });
};

const peelTargets = (
  value: unknown,
  source: string,
  diagnostics: Diagnostic[],
): SkillIrExtensions => {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) {
    diagnostics.push({
      code: 'AB3006',
      message: 'Skill `targets` must be an object with optional `claude`, `cursor`, and `codex` keys.',
      recovery: 'Replace `targets` with a typed per-host object.',
      severity: 'error',
      sourcePath: source,
    });
    return {};
  }
  const unknown = Object.keys(value).filter((key) => key !== 'claude' && key !== 'codex' && key !== 'cursor');
  for (const key of unknown) diagnostics.push(unknownField(source, `targets.${key}`));
  if (isPlainRecord(value.claude)) {
    reportUnknownFields(value.claude, claudeTargetKeys, 'targets.claude', source, diagnostics);
  }
  if (isPlainRecord(value.cursor)) {
    reportUnknownFields(value.cursor, cursorTargetKeys, 'targets.cursor', source, diagnostics);
  }
  if (isPlainRecord(value.codex)) {
    reportUnknownFields(value.codex, codexTargetKeys, 'targets.codex', source, diagnostics);
    if (isPlainRecord(value.codex.interface)) {
      reportUnknownFields(
        value.codex.interface,
        codexInterfaceKeys,
        'targets.codex.interface',
        source,
        diagnostics,
      );
    }
    if (isPlainRecord(value.codex.policy)) {
      reportUnknownFields(
        value.codex.policy,
        codexPolicyKeys,
        'targets.codex.policy',
        source,
        diagnostics,
      );
    }
    if (isPlainRecord(value.codex.dependencies)) {
      reportUnknownFields(
        value.codex.dependencies,
        codexDependenciesKeys,
        'targets.codex.dependencies',
        source,
        diagnostics,
      );
      if (Array.isArray(value.codex.dependencies.tools)) {
        value.codex.dependencies.tools.forEach((tool, index) => {
          if (isPlainRecord(tool)) {
            reportUnknownFields(
              tool,
              codexToolKeys,
              `targets.codex.dependencies.tools[${index}]`,
              source,
              diagnostics,
            );
          }
        });
      }
    }
  }
  const claude = isPlainRecord(value.claude)
    ? claudeFrom({
      ...value.claude,
      'argument-hint': value.claude.argumentHint ?? value.claude['argument-hint'],
      'disable-model-invocation': value.claude.disableModelInvocation ?? value.claude['disable-model-invocation'],
      'disallowed-tools': value.claude.disallowedTools ?? value.claude['disallowed-tools'],
      'user-invocable': value.claude.userInvocable ?? value.claude['user-invocable'],
      when_to_use: value.claude.whenToUse ?? value.claude.when_to_use,
      'allowed-tools': value.claude.allowedTools ?? value.claude['allowed-tools'],
    })
    : undefined;
  const cursor = isPlainRecord(value.cursor)
    ? cursorFrom({
      ...value.cursor,
      'disable-model-invocation': value.cursor.disableModelInvocation ?? value.cursor['disable-model-invocation'],
    })
    : undefined;
  const codex = codexFrom(value.codex);
  return {
    ...(claude === undefined ? {} : { claude }),
    ...(codex === undefined ? {} : { codex }),
    ...(cursor === undefined ? {} : { cursor }),
  };
};

export const parseSkillIr = (document: SkillDocument): SkillIr => {
  const diagnostics: Diagnostic[] = [...document.diagnostics];
  const frontmatter = document.frontmatter;
  const unknownKeys = Object.keys(frontmatter).filter((key) =>
    !portableKeys.has(key) &&
    !claudeOnlyKeys.has(key) &&
    !sharedKeys.has(key) &&
    !cursorOnlyKeys.has(key) &&
    !authoringKeys.has(key)
  );
  for (const key of unknownKeys) diagnostics.push(unknownField(document.source, key));

  const peeledClaude: Record<string, unknown> = {};
  const peeledCursor: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (claudeOnlyKeys.has(key) || sharedKeys.has(key)) peeledClaude[key] = value;
    if (cursorOnlyKeys.has(key) || sharedKeys.has(key)) peeledCursor[key] = value;
  }

  const fromFrontmatter: SkillIrExtensions = {
    ...(claudeFrom(peeledClaude) === undefined ? {} : { claude: claudeFrom(peeledClaude) }),
    ...(cursorFrom(peeledCursor) === undefined ? {} : { cursor: cursorFrom(peeledCursor) }),
  };
  const fromTargets = peelTargets(frontmatter.targets ?? document.authoredTargets, document.source, diagnostics);
  const extensions: SkillIrExtensions = Object.freeze({
    ...(mergeClaude(fromFrontmatter.claude, fromTargets.claude) === undefined
      ? {}
      : { claude: mergeClaude(fromFrontmatter.claude, fromTargets.claude) }),
    ...(mergeCursor(fromFrontmatter.cursor, fromTargets.cursor) === undefined
      ? {}
      : { cursor: mergeCursor(fromFrontmatter.cursor, fromTargets.cursor) }),
    ...(fromTargets.codex === undefined ? {} : { codex: fromTargets.codex }),
  });

  const placeholders: SkillIrPlaceholder[] = findSkillTokens(document.body).map((occurrence) =>
    Object.freeze({ ...occurrence, required: true as const }),
  );
  const sidecar = sidecarFromResource(document);
  const hasExtensions = extensions.claude !== undefined ||
    extensions.codex !== undefined ||
    extensions.cursor !== undefined;
  const passThrough = diagnostics.every((diagnostic) => diagnostic.severity !== 'error') &&
    !hasExtensions &&
    placeholders.length === 0;

  return deepFreeze({
    ...(document.authoredTargets === undefined ? {} : { authoredTargets: document.authoredTargets }),
    body: document.body,
    diagnostics: Object.freeze(diagnostics),
    extensions,
    markdown: document.markdown,
    passThrough,
    placeholders: Object.freeze(placeholders),
    portable: portableFrom(frontmatter),
    resources: deepFreeze(document.resources.map((resource) => ({
      bytes: resource.bytes,
      relativePath: resource.relativePath,
      source: resource.source,
    }))),
    sidecars: Object.freeze(sidecar === undefined ? [] : [sidecar]),
    source: document.source,
  });
};
