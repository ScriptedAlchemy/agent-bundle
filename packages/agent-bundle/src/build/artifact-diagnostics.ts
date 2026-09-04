import type { Diagnostic } from '../core/diagnostics.ts';

export type ArtifactDiagnosticCode =
  | 'AB6000'
  | 'AB6001'
  | 'AB6002'
  | 'AB6003'
  | 'AB6004'
  | 'AB6005'
  | 'AB6006'
  | 'AB6007'
  | 'AB6008'
  | 'AB6009'
  | 'AB6010'
  | 'AB6011'
  | 'AB6012'
  | 'AB6013'
  | 'AB6014'
  | 'AB6015'
  | 'AB6016'
  | 'AB6017'
  | 'AB6018'
  | 'AB6019'
  | 'AB6020'
  | 'AB6021'
  | 'AB6022'
  | 'AB6023'
  | 'AB6024'
  | 'AB6025'
  | 'AB6034';

export const artifactDiagnosticRecoveries: Readonly<Record<ArtifactDiagnosticCode, string>> = Object.freeze({
  AB6000: 'Restore a readable artifact root and canonical manifest, then rebuild the artifact.',
  AB6001: 'Regenerate the strict canonical manifest without concurrent writes, then rerun validation.',
  AB6002: 'Rebuild the artifact from complete project source, then rerun validation.',
  AB6003: 'Rebuild the artifact with canonical generated output, then rerun validation.',
  AB6004: 'Rebuild the artifact so its file table and contents match the manifest.',
  AB6005: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
  AB6006: 'Regenerate the affected JSON document as valid JSON, then rebuild the artifact.',
  AB6007: 'Repair MCP manifest references to generated servers, then rebuild the artifact.',
  AB6008: 'Rebuild the artifact with the pinned Agent Skills contract.',
  AB6009: 'Rebuild the artifact with a registered target.',
  AB6010: 'Rebuild the artifact with the current target registry.',
  AB6011: 'Generate the required target document, then rebuild the artifact.',
  AB6012: 'Correct the target document source so it satisfies its schema, then rebuild the artifact.',
  AB6013: 'Remove unsupported filesystem entries and rebuild the artifact.',
  AB6014: 'Rebuild the artifact with files only in declared target namespaces.',
  AB6015: 'Restore canonical Skill Markdown and copied resources, then rebuild the artifact.',
  AB6016: 'Copy every referenced Skill resource inside its Skill root, then rebuild the artifact.',
  AB6017: 'Rebuild the artifact so every target MCP manifest references its exact compiler outputs.',
  AB6018: 'Rebuild the artifact so native hook commands and hook metadata agree.',
  AB6019: 'Install Claude Code and ensure `claude` is on PATH, then rerun artifact validation.',
  AB6020: 'Run `claude plugin validate <bundle-dir>/.claude-plugin/plugin.json --strict`, repair the warning, and rebuild.',
  AB6021: 'Run `claude plugin validate <bundle-dir>/.claude-plugin/plugin.json --strict`, repair the error, and rebuild.',
  AB6022: 'Restore a bounded Claude validator process, then rerun artifact validation.',
  AB6023: 'Rebuild the artifact so every built-in target includes its generated INSTALL.md.',
  AB6024: 'Rebuild the Cursor-compatible artifact so it includes its generated install.mjs.',
  AB6025: 'Rebuild the artifact so every manifest-declared logo path copies into the deploy tree.',
  AB6034: 'Add Markdown instructions after the Skill frontmatter, then rebuild the artifact.',
});

const isArtifactDiagnosticCode = (code: string): code is ArtifactDiagnosticCode =>
  Object.hasOwn(artifactDiagnosticRecoveries, code);

const recoveryForArtifactDiagnostic = (code: string): string =>
  isArtifactDiagnosticCode(code)
    ? artifactDiagnosticRecoveries[code]
    : 'Repair the target MCP configuration and rebuild the artifact.';

export const artifactDiagnostic = (
  code: string,
  message: string,
  generatedPath?: string,
  target?: string,
  recovery = recoveryForArtifactDiagnostic(code),
): Diagnostic => ({
  code,
  generatedPath,
  message,
  recovery,
  severity: 'error',
  ...(target === undefined ? {} : { target }),
});
