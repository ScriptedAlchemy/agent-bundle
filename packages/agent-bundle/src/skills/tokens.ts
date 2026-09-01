import { deepFreeze } from '../core/freeze.ts';

/**
 * Canonical Skill / plugin-surface tokens. Build-time lowering substitutes
 * host syntax only; runtime values are never resolved here.
 *
 * Plugin/project-root spellings are the same bytes as `pathTokens` in
 * `core/types.ts` so MCP, hooks, and skills share one registry (#108 / #107 R12).
 * This module must not import `core/types.ts` — NormalizedSkill lives there
 * and imports the Skill IR types.
 */
export const skillTokenSpellings = Object.freeze({
  arguments: 'agent-bundle:token:arguments',
  pluginData: 'agent-bundle:path:plugin-data',
  pluginRoot: 'agent-bundle:path:plugin-root',
  projectRoot: 'agent-bundle:path:workspace-root',
  sessionIdentity: 'agent-bundle:token:session-identity',
  skillRoot: 'agent-bundle:token:skill-root',
} as const);

export type SkillTokenId = keyof typeof skillTokenSpellings;

export type SkillHost = 'claude' | 'codex' | 'cursor' | 'portable';

export type SkillDocumentKind =
  | 'commands'
  | 'hooks'
  | 'mcp'
  | 'plugin-config'
  | 'prompts'
  | 'skill-frontmatter'
  | 'skill-markdown';

export type SkillTokenClass = 'namespaced' | 'none' | 'portable';

export interface SkillTokenClassification {
  readonly class: SkillTokenClass;
  readonly document: SkillDocumentKind;
  readonly evidence: string;
  readonly host: SkillHost;
  readonly syntax?: string;
  readonly token: SkillTokenId;
}

const claudeSkills = 'https://code.claude.com/docs/en/skills (Claude Code 2.1.250 pin)';
const claudePlugins = 'https://code.claude.com/docs/en/plugins-reference (Claude Code 2.1.250 pin)';
const codexSkills = 'https://learn.chatgpt.com/docs/build-skills (Codex 0.147.0 pin)';
const codexPlugins = 'https://developers.openai.com/plugins/build/plugins (Codex 0.147.0 pin)';
const cursorSkills = 'https://prod.cursor.com/docs/skills (Cursor 2026-08-28 pin)';
const cursorPlugins = 'https://prod.cursor.com/docs/reference/plugins (cursor/plugins@070189284e702e8a4d2e3cc8913994b204c5337a)';
const portableSkills = 'https://agentskills.io/specification (69ef37e9424c0a7ea9dd2293b559e43ec8176379)';

const none = (
  token: SkillTokenId,
  host: SkillHost,
  document: SkillDocumentKind,
  evidence: string,
): SkillTokenClassification => Object.freeze({ class: 'none', document, evidence, host, token });

const portable = (
  token: SkillTokenId,
  host: SkillHost,
  document: SkillDocumentKind,
  syntax: string,
  evidence: string,
): SkillTokenClassification => Object.freeze({
  class: 'portable',
  document,
  evidence,
  host,
  syntax,
  token,
});

type HostDocumentTable = Partial<Record<SkillDocumentKind, Partial<Record<SkillTokenId, SkillTokenClassification>>>>;

const table: Record<SkillHost, HostDocumentTable> = {
  claude: {
    'plugin-config': {
      pluginData: portable('pluginData', 'claude', 'plugin-config', '${CLAUDE_PLUGIN_DATA}', claudePlugins),
      pluginRoot: portable('pluginRoot', 'claude', 'plugin-config', '${CLAUDE_PLUGIN_ROOT}', claudePlugins),
      projectRoot: portable('projectRoot', 'claude', 'plugin-config', '${CLAUDE_PROJECT_DIR}', claudePlugins),
    },
    hooks: {
      pluginData: portable('pluginData', 'claude', 'hooks', '${CLAUDE_PLUGIN_DATA}', claudePlugins),
      pluginRoot: portable('pluginRoot', 'claude', 'hooks', '${CLAUDE_PLUGIN_ROOT}', claudePlugins),
      projectRoot: portable('projectRoot', 'claude', 'hooks', '${CLAUDE_PROJECT_DIR}', claudePlugins),
    },
    mcp: {
      pluginData: portable('pluginData', 'claude', 'mcp', '${CLAUDE_PLUGIN_DATA}', claudePlugins),
      pluginRoot: portable('pluginRoot', 'claude', 'mcp', '${CLAUDE_PLUGIN_ROOT}', claudePlugins),
      projectRoot: portable('projectRoot', 'claude', 'mcp', '${CLAUDE_PROJECT_DIR}', claudePlugins),
    },
    'skill-frontmatter': {
      pluginData: portable('pluginData', 'claude', 'skill-frontmatter', '${CLAUDE_PLUGIN_DATA}', claudeSkills),
      pluginRoot: portable('pluginRoot', 'claude', 'skill-frontmatter', '${CLAUDE_PLUGIN_ROOT}', claudeSkills),
      projectRoot: portable('projectRoot', 'claude', 'skill-frontmatter', '${CLAUDE_PROJECT_DIR}', claudeSkills),
      skillRoot: portable('skillRoot', 'claude', 'skill-frontmatter', '${CLAUDE_SKILL_DIR}', claudeSkills),
    },
    'skill-markdown': {
      arguments: portable('arguments', 'claude', 'skill-markdown', '$ARGUMENTS', claudeSkills),
      pluginData: portable('pluginData', 'claude', 'skill-markdown', '${CLAUDE_PLUGIN_DATA}', claudeSkills),
      pluginRoot: portable('pluginRoot', 'claude', 'skill-markdown', '${CLAUDE_PLUGIN_ROOT}', claudeSkills),
      projectRoot: portable('projectRoot', 'claude', 'skill-markdown', '${CLAUDE_PROJECT_DIR}', claudeSkills),
      sessionIdentity: portable('sessionIdentity', 'claude', 'skill-markdown', '${CLAUDE_SESSION_ID}', claudeSkills),
      skillRoot: portable('skillRoot', 'claude', 'skill-markdown', '${CLAUDE_SKILL_DIR}', claudeSkills),
    },
  },
  codex: {
    hooks: {
      pluginData: portable('pluginData', 'codex', 'hooks', '${PLUGIN_DATA}', codexPlugins),
      pluginRoot: portable('pluginRoot', 'codex', 'hooks', '${PLUGIN_ROOT}', codexPlugins),
    },
    mcp: {
      pluginRoot: portable('pluginRoot', 'codex', 'mcp', '${PLUGIN_ROOT}', codexPlugins),
    },
    'plugin-config': {
      pluginData: portable('pluginData', 'codex', 'plugin-config', '${PLUGIN_DATA}', codexPlugins),
      pluginRoot: portable('pluginRoot', 'codex', 'plugin-config', '${PLUGIN_ROOT}', codexPlugins),
    },
  },
  cursor: {
    hooks: {
      pluginRoot: portable('pluginRoot', 'cursor', 'hooks', '${CURSOR_PLUGIN_ROOT}', cursorPlugins),
      projectRoot: portable('projectRoot', 'cursor', 'hooks', '${workspaceFolder}', cursorPlugins),
    },
    mcp: {
      pluginRoot: portable('pluginRoot', 'cursor', 'mcp', '${CURSOR_PLUGIN_ROOT}', cursorPlugins),
      projectRoot: portable('projectRoot', 'cursor', 'mcp', '${workspaceFolder}', cursorPlugins),
    },
    'plugin-config': {
      pluginRoot: portable('pluginRoot', 'cursor', 'plugin-config', '${CURSOR_PLUGIN_ROOT}', cursorPlugins),
      projectRoot: portable('projectRoot', 'cursor', 'plugin-config', '${workspaceFolder}', cursorPlugins),
    },
  },
  portable: {
    mcp: {
      pluginData: portable('pluginData', 'portable', 'mcp', '${PLUGIN_DATA}', portableSkills),
      pluginRoot: portable('pluginRoot', 'portable', 'mcp', '${PLUGIN_ROOT}', portableSkills),
    },
    'plugin-config': {
      pluginData: portable('pluginData', 'portable', 'plugin-config', '${PLUGIN_DATA}', portableSkills),
      pluginRoot: portable('pluginRoot', 'portable', 'plugin-config', '${PLUGIN_ROOT}', portableSkills),
    },
  },
};

const noSkillMarkdown = {
  claude: claudeSkills,
  codex: `${codexSkills}: Codex documents no Skill Markdown interpolation engine`,
  cursor: `${cursorSkills}: documented \${VAR} interpolation belongs to plugin configuration, not Skill Markdown`,
  portable: `${portableSkills}: portable Agent Skills define no runtime placeholder syntax`,
} as const;

export const classifySkillToken = (
  token: SkillTokenId,
  host: SkillHost,
  document: SkillDocumentKind,
): SkillTokenClassification =>
  table[host][document]?.[token] ?? none(token, host, document, noSkillMarkdown[host]);

/** Host-native spellings that parse as a canonical token. Longest match wins. */
export const skillTokenAliases: Readonly<Record<SkillTokenId, readonly string[]>> = deepFreeze({
  arguments: ['$ARGUMENTS'],
  pluginData: ['${CLAUDE_PLUGIN_DATA}', '${PLUGIN_DATA}'],
  pluginRoot: ['${CLAUDE_PLUGIN_ROOT}', '${CURSOR_PLUGIN_ROOT}', '${PLUGIN_ROOT}'],
  projectRoot: ['${CLAUDE_PROJECT_DIR}', '${workspaceFolder}'],
  sessionIdentity: ['${CLAUDE_SESSION_ID}'],
  skillRoot: ['${CLAUDE_SKILL_DIR}'],
});

const aliasEntries = (Object.entries(skillTokenAliases) as [SkillTokenId, readonly string[]][])
  .flatMap(([token, aliases]) => [
    { alias: skillTokenSpellings[token], token },
    ...aliases.map((alias) => ({ alias, token })),
  ])
  .sort((left, right) => right.alias.length - left.alias.length);

export interface SkillTokenOccurrence {
  readonly alias: string;
  readonly index: number;
  readonly token: SkillTokenId;
}

/** Finds canonical spellings and host-native aliases. Does not resolve runtime values. */
export const findSkillTokens = (text: string): readonly SkillTokenOccurrence[] => {
  const found: SkillTokenOccurrence[] = [];
  const consumed = new Set<number>();
  for (const { alias, token } of aliasEntries) {
    let from = 0;
    while (from <= text.length - alias.length) {
      const index = text.indexOf(alias, from);
      if (index === -1) break;
      let already = false;
      for (let offset = 0; offset < alias.length; offset += 1) {
        if (consumed.has(index + offset)) {
          already = true;
          break;
        }
      }
      if (!already) {
        found.push({ alias, index, token });
        for (let offset = 0; offset < alias.length; offset += 1) consumed.add(index + offset);
      }
      from = index + alias.length;
    }
  }
  return Object.freeze(found.sort((left, right) => left.index - right.index || left.token.localeCompare(right.token)));
};

const hostSkillMarkdownSyntax = (host: SkillHost): readonly string[] =>
  (Object.keys(skillTokenSpellings) as SkillTokenId[])
    .map((token) => classifySkillToken(token, host, 'skill-markdown').syntax)
    .filter((syntax): syntax is string => syntax !== undefined);

/** Syntax that belongs to a different host's Skill Markdown and must not leak. */
export const foreignSkillMarkdownSyntax = (host: SkillHost): readonly string[] => {
  const owned = new Set(hostSkillMarkdownSyntax(host));
  const foreign = new Set<string>();
  for (const other of ['claude', 'codex', 'cursor', 'portable'] as const) {
    if (other === host) continue;
    for (const syntax of hostSkillMarkdownSyntax(other)) {
      if (!owned.has(syntax)) foreign.add(syntax);
    }
  }
  return Object.freeze([...foreign].sort());
};

export const replaceSkillTokens = (
  text: string,
  replace: (occurrence: SkillTokenOccurrence) => string,
): string => {
  const occurrences = findSkillTokens(text);
  if (occurrences.length === 0) return text;
  let result = '';
  let cursor = 0;
  for (const occurrence of occurrences) {
    result += text.slice(cursor, occurrence.index);
    result += replace(occurrence);
    cursor = occurrence.index + occurrence.alias.length;
  }
  return result + text.slice(cursor);
};
