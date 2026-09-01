import type { Diagnostic } from '../core/diagnostics.ts';
import type { SkillTokenId, SkillTokenOccurrence } from './tokens.ts';

export interface PortableSkillMetadata {
  readonly allowedTools?: string;
  readonly compatibility?: string;
  readonly description?: string;
  readonly license?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly name?: string;
}

export interface ClaudeSkillExtension {
  readonly agent?: string;
  readonly allowedTools?: string | readonly string[];
  readonly argumentHint?: string;
  readonly arguments?: readonly string[];
  readonly background?: boolean;
  readonly context?: 'fork';
  readonly disableModelInvocation?: boolean;
  readonly disallowedTools?: string | readonly string[];
  readonly effort?: 'high' | 'low' | 'max' | 'medium' | 'xhigh';
  readonly hooks?: Readonly<Record<string, unknown>>;
  readonly model?: string;
  readonly paths?: readonly string[];
  readonly shell?: 'bash' | 'powershell';
  readonly userInvocable?: boolean;
  readonly whenToUse?: string;
}

export interface CursorSkillExtension {
  readonly color?: string;
  readonly disableModelInvocation?: boolean;
  readonly globs?: string | readonly string[];
  readonly icon?: string;
  readonly paths?: readonly string[];
}

export interface CodexSkillToolDependency {
  readonly description?: string;
  readonly transport?: string;
  readonly type?: string;
  readonly url?: string;
  readonly value?: string;
}

export interface CodexSkillExtension {
  readonly dependencies?: {
    readonly tools?: readonly CodexSkillToolDependency[];
  };
  readonly interface?: {
    readonly brandColor?: string;
    readonly defaultPrompt?: string;
    readonly displayName?: string;
    readonly iconLarge?: string;
    readonly iconSmall?: string;
    readonly shortDescription?: string;
  };
  readonly policy?: {
    readonly allowImplicitInvocation?: boolean;
  };
}

export interface SkillIrExtensions {
  readonly claude?: ClaudeSkillExtension;
  readonly codex?: CodexSkillExtension;
  readonly cursor?: CursorSkillExtension;
}

export interface SkillSidecarRef {
  readonly content?: string;
  readonly relativePath: string;
  readonly source?: string;
}

export interface SkillResourceRef {
  readonly bytes: number;
  readonly relativePath: string;
  readonly source: string;
}

export interface SkillIrPlaceholder extends SkillTokenOccurrence {
  readonly required: true;
}

export interface SkillIr {
  readonly authoredTargets?: unknown;
  readonly body: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly extensions: SkillIrExtensions;
  readonly markdown: string;
  readonly passThrough: boolean;
  readonly placeholders: readonly SkillIrPlaceholder[];
  readonly portable: PortableSkillMetadata;
  readonly resources: readonly SkillResourceRef[];
  readonly sidecars: readonly SkillSidecarRef[];
  readonly source: string;
}

export interface SkillTreeLayoutDecision {
  readonly decision: 'per-host-required' | 'shared';
  readonly evidence: string;
  readonly feeds: '#101';
  readonly reason: string;
}

export interface SkillHostDocument {
  readonly diagnostics: readonly Diagnostic[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly passThrough: boolean;
  readonly sidecars: readonly SkillSidecarRef[];
  readonly skillMarkdown: string;
  readonly target: string;
  readonly tokenLowering: readonly SkillTokenLoweringRecord[];
}

export interface SkillTokenLoweringRecord {
  readonly alias: string;
  readonly class: 'none' | 'portable';
  readonly document: 'skill-markdown';
  readonly host: string;
  readonly syntax?: string;
  readonly token: SkillTokenId;
}
