import type { ClaudeSkillExtension, CodexSkillExtension, CursorSkillExtension } from './ir.ts';
import { skillTokenSpellings } from './tokens.ts';

export interface DefinedSkillTargets {
  readonly claude?: ClaudeSkillExtension;
  readonly codex?: CodexSkillExtension;
  readonly cursor?: CursorSkillExtension;
}

export interface DefinedSkill {
  readonly description: string;
  readonly name: string;
  readonly targets?: DefinedSkillTargets;
}

/** Identity helper so authors can type a Skill definition next to a rendered source. */
export const defineSkill = <Skill extends DefinedSkill>(skill: Skill): Skill => skill;

/**
 * Rendered-skill components that emit canonical tokens. The Markdown renderer
 * resolves function components to strings; host syntax is applied only during
 * lowering, never here.
 */
export const Skill = Object.freeze({
  Arguments: (): string => skillTokenSpellings.arguments,
  PluginData: (): string => skillTokenSpellings.pluginData,
  PluginRoot: (): string => skillTokenSpellings.pluginRoot,
  ProjectRoot: (): string => skillTokenSpellings.projectRoot,
  Resource: ({ path }: { readonly path: string }): string => `[${path}](${path})`,
  SessionIdentity: (): string => skillTokenSpellings.sessionIdentity,
  SkillRoot: (): string => skillTokenSpellings.skillRoot,
});
