import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { Effect, FileSystem, Option } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

import type { Diagnostic, DiagnosticSeverity } from '../core/diagnostics.ts';
import { freezeDiagnostics } from '../core/diagnostics.ts';
import { sha256Hex } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import capabilityTable from '../adapters/capabilities/codex-0.147.0.json' with { type: 'json' };
import { codexArtifactPaths } from '../adapters/codex.ts';
import hooksSchema from '../adapters/schemas/codex/hooks.schema.json' with { type: 'json' };
import marketplaceSchema from '../adapters/schemas/codex/marketplace.schema.json' with { type: 'json' };
import mcpSchema from '../adapters/schemas/codex/mcp.schema.json' with { type: 'json' };
import pluginSchema from '../adapters/schemas/codex/plugin.schema.json' with { type: 'json' };
import {
  createAdapterValidator,
  validateJsonSchemaDocument,
  type TargetArtifactDocumentValidator,
} from '../adapters/types.ts';
import {
  runBoundedChildProcess,
  type BoundedChildProcessRequest,
  type BoundedChildProcessResult,
} from './process.ts';
// Imported last on purpose: see the matching note in `src/api.ts` — the
// position of `effect/lift.ts` in the module graph keeps the emitted hook
// bundles byte-identical.
import { runWithPlatform, withTempDirectory } from '../effect/platform.ts';
import { liftPromise } from '../effect/lift.ts';

const maximumOutputBytes = 1024 * 1024;
const schemaGenerationTimeoutMs = 15_000;
const versionTimeoutMs = 5_000;
const pinnedRevision = capabilityTable.observedCliVersion;

/** Every generated hook command schema pinned from the rust-v0.147.0 tag. */
const generatedSchemaNames = Object.freeze(
  Object.keys(capabilityTable.validation.pinnedGeneratedComparison.pinnedRepositorySha256).sort(),
);

type CodexPluginTermination = 'output-limit' | 'timed-out';
type CodexPluginDiagnosticCode = 'AB6030' | 'AB6031' | 'AB6032' | 'AB6033';

export type CodexPluginValidationStatus = 'failed' | 'passed' | 'unavailable' | 'warnings';

export interface CodexPluginValidationReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly host: 'codex';
  readonly status: CodexPluginValidationStatus;
  readonly target: string;
  readonly version?: string;
}

export type CodexPluginCommandResult = BoundedChildProcessResult<CodexPluginTermination>;

export type CodexPluginCommandRunner = (
  request: BoundedChildProcessRequest,
) => Promise<CodexPluginCommandResult>;

export interface ValidateCodexPluginOptions {
  readonly executable?: string;
  readonly pluginDirectory: string;
  /** Injectable proof seam. Production always uses the bounded process runner. */
  readonly run?: CodexPluginCommandRunner;
  /** Promote live-schema drift to an Agent Bundle error. */
  readonly strict?: boolean;
  readonly target: string;
}

export interface ValidateCodexPluginFilesOptions {
  readonly pluginDirectory: string;
  readonly target: string;
}

interface PinnedDocumentContract {
  readonly path: string;
  readonly required: boolean;
  readonly validate: TargetArtifactDocumentValidator;
}

const schemaValidator = createAdapterValidator();
const pinnedDocumentContracts = Object.freeze<PinnedDocumentContract[]>([
  Object.freeze({
    path: codexArtifactPaths.plugin,
    required: true,
    validate: validateJsonSchemaDocument(schemaValidator.compile(pluginSchema)),
  }),
  Object.freeze({
    path: codexArtifactPaths.hooksManifest,
    required: false,
    validate: validateJsonSchemaDocument(schemaValidator.compile(hooksSchema)),
  }),
  Object.freeze({
    path: codexArtifactPaths.mcp,
    required: false,
    validate: validateJsonSchemaDocument(schemaValidator.compile(mcpSchema)),
  }),
  Object.freeze({
    path: codexArtifactPaths.marketplace,
    required: false,
    validate: validateJsonSchemaDocument(schemaValidator.compile(marketplaceSchema)),
  }),
]);

const runCodexCommand: CodexPluginCommandRunner = (request) => runBoundedChildProcess(request, {
  labels: { outputLimit: 'output-limit', timedOut: 'timed-out' },
  maxOutputBytes: maximumOutputBytes,
  timeoutMs: request.args[0] === '--version' ? versionTimeoutMs : schemaGenerationTimeoutMs,
  windowsHide: true,
});

const versionFrom = (output: string): string | undefined =>
  /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(output)?.[1];

const diagnostic = (
  code: CodexPluginDiagnosticCode,
  message: string,
  severity: DiagnosticSeverity,
  target: string,
  recovery: string,
  generatedPath?: string,
): Diagnostic => Object.freeze({
  code,
  ...(generatedPath === undefined ? {} : { generatedPath }),
  message,
  recovery,
  severity,
  target,
});

const commandFailureMessage = (
  operation: 'schema generation' | 'version probe',
  result: CodexPluginCommandResult,
): string => {
  if (result.termination === 'timed-out') return `Codex CLI ${operation} timed out.`;
  if (result.termination === 'output-limit') return `Codex CLI ${operation} exceeded its output limit.`;
  return `Codex CLI ${operation} exited with code ${result.exitCode ?? 'unknown'}.`;
};

const validatePinnedDocuments = async (
  pluginDirectory: string,
  target: string,
): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  for (const contract of pinnedDocumentContracts) {
    const path = join(pluginDirectory, contract.path);
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT') && !contract.required) continue;
      diagnostics.push(diagnostic(
        'AB6032',
        isErrno(error, 'ENOENT')
          ? `Required Codex bundle document ${contract.path} is missing.`
          : `Codex bundle document ${contract.path} could not be read.`,
        'error',
        target,
        'Rebuild the Codex bundle, then repair any document that does not satisfy its vendored pinned schema.',
        contract.path,
      ));
      continue;
    }

    let document: unknown;
    try {
      document = JSON.parse(source);
    } catch {
      diagnostics.push(diagnostic(
        'AB6032',
        `Codex bundle document ${contract.path} is not valid JSON.`,
        'error',
        target,
        'Repair the generated JSON document and rebuild the Codex bundle.',
        contract.path,
      ));
      continue;
    }

    for (const issue of contract.validate(document)) {
      diagnostics.push(diagnostic(
        'AB6032',
        `Codex bundle document ${contract.path}${issue.instancePath} ${issue.message}.`,
        'error',
        target,
        'Repair the generated Codex document so it satisfies the vendored pinned schema, then rebuild.',
        contract.path,
      ));
    }
  }
  return freezeDiagnostics(diagnostics);
};

export const validateCodexPluginFiles = async (
  options: ValidateCodexPluginFilesOptions,
): Promise<readonly Diagnostic[]> =>
  validatePinnedDocuments(resolve(options.pluginDirectory), options.target);

const generatedJsonFiles = async (directory: string): Promise<readonly string[]> =>
  Object.freeze((await readdir(directory, { recursive: true }))
    .filter((path) => path.endsWith('.json'))
    .sort());

const compareGeneratedSchemas = async (
  liveDirectory: string,
  liveVersion: string | undefined,
  strict: boolean,
  target: string,
): Promise<readonly Diagnostic[]> => {
  const pinnedDirectory = new URL('../adapters/schemas/codex/generated/', import.meta.url);
  const missing: string[] = [];
  const changed: string[] = [];
  for (const name of generatedSchemaNames) {
    try {
      const [live, pinned] = await Promise.all([
        readFile(join(liveDirectory, name)),
        readFile(new URL(name, pinnedDirectory)),
      ]);
      if (sha256Hex(live) !== sha256Hex(pinned)) changed.push(name);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        missing.push(name);
        continue;
      }
      throw error;
    }
  }
  if (missing.length === 0 && changed.length === 0) return Object.freeze([]);

  const liveFiles = await generatedJsonFiles(liveDirectory);
  const appServerBundlesPresent = [
    'codex_app_server_protocol.schemas.json',
    'codex_app_server_protocol.v2.schemas.json',
  ].every((path) => liveFiles.includes(path));
  if (missing.length === generatedSchemaNames.length && appServerBundlesPresent) {
    return freezeDiagnostics([diagnostic(
      'AB6031',
      `Codex ${liveVersion ?? 'unknown'} live hook-schema drift is not assessable because the generator emits ` +
        `the app-server protocol surface, which is unpinned for plugin hook validation against Codex ${pinnedRevision}.`,
      'info',
      target,
      'Retain validation against the vendored pinned hook schemas until Codex publishes a comparable live hook-schema surface.',
    )]);
  }
  const details = [
    ...(missing.length === 0 ? [] : [`missing ${missing.join(', ')}`]),
    ...(changed.length === 0 ? [] : [`changed ${changed.join(', ')}`]),
  ].join('; ');
  return freezeDiagnostics([diagnostic(
    'AB6031',
    `The live Codex ${liveVersion ?? 'unknown'} schema set does not match pinned Codex ${pinnedRevision} ` +
      `generated hook schemas (${details}); the command emitted ${liveFiles.length} JSON schema files.`,
    strict ? 'error' : 'warning',
    target,
    'Review the live host schema source and update the pinned revision only from a published, attributable Codex contract.',
  )]);
};

const schemaVerbUnavailable = (output: string): boolean =>
  /(?:unrecognized|unknown|invalid) (?:subcommand|command)|no such (?:subcommand|command)/iu.test(output);

/**
 * Runs the live schema generator into a temporary directory and compares
 * its output with the pinned revision. Every generator failure is reported
 * as a diagnostic (AB6033 / AB6031), never thrown; the directory is removed
 * whichever way the program settles.
 */
const schemaGenerationDiagnostics = (
  options: Readonly<{
    readonly cwd: string;
    readonly executable: string;
    readonly run: CodexPluginCommandRunner;
    readonly strict: boolean;
    readonly target: string;
    readonly version: string | undefined;
  }>,
): Effect.Effect<readonly Diagnostic[], PlatformError, FileSystem.FileSystem> => withTempDirectory(
  { prefix: 'agent-bundle-codex-schema-' },
  (outputDirectory) => Effect.gen(function* () {
    const started = yield* liftPromise(() => options.run(Object.freeze({
      args: Object.freeze(['app-server', 'generate-json-schema', '--out', outputDirectory]),
      cwd: options.cwd,
      executable: options.executable,
    }))).pipe(Effect.option);
    if (Option.isNone(started)) {
      return freezeDiagnostics([diagnostic(
        'AB6033',
        'Codex CLI schema generation could not be started.',
        'error',
        options.target,
        'Verify the Codex CLI starts and supports app-server schema generation, then rerun artifact validation.',
      )]);
    }
    const result: CodexPluginCommandResult = started.value;

    if (result.termination !== undefined) {
      return freezeDiagnostics([diagnostic(
        'AB6033',
        commandFailureMessage('schema generation', result),
        'error',
        options.target,
        'Rerun Codex schema generation within the configured time and output bounds.',
      )]);
    }
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`;
      if (schemaVerbUnavailable(output)) {
        return freezeDiagnostics([diagnostic(
          'AB6031',
          `The Codex ${options.version ?? 'unknown'} app-server generate-json-schema verb is unavailable; ` +
            `live schema drift could not be checked against pinned Codex ${pinnedRevision}.`,
          'info',
          options.target,
          'Use a Codex release that publishes app-server schema generation, or retain validation against the vendored pinned schemas.',
        )]);
      }
      return freezeDiagnostics([diagnostic(
        'AB6033',
        commandFailureMessage('schema generation', result),
        'error',
        options.target,
        'Run `codex app-server generate-json-schema --out <dir>` successfully, then rerun artifact validation.',
      )]);
    }

    return yield* liftPromise(() => compareGeneratedSchemas(
      outputDirectory,
      options.version,
      options.strict,
      options.target,
    )).pipe(Effect.catch(() => Effect.succeed(freezeDiagnostics([diagnostic(
      'AB6033',
      'Codex CLI generated schema output could not be inspected.',
      'error',
      options.target,
      'Ensure the generated schema directory is readable, then rerun artifact validation.',
    )]))));
  }),
);

export const validateCodexPlugin = async (
  options: ValidateCodexPluginOptions,
): Promise<CodexPluginValidationReport> => {
  const pluginDirectory = resolve(options.pluginDirectory);
  const executable = options.executable ?? 'codex';
  const run = options.run ?? runCodexCommand;
  const cwd = dirname(pluginDirectory);
  let version: string | undefined;
  try {
    const probe = await run(Object.freeze({ args: Object.freeze(['--version']), cwd, executable }));
    if (probe.exitCode !== 0 || probe.termination !== undefined) {
      return Object.freeze({
        diagnostics: freezeDiagnostics([diagnostic(
          'AB6033',
          commandFailureMessage('version probe', probe),
          'error',
          options.target,
          'Verify the Codex CLI starts and responds to `codex --version`, then rerun artifact validation.',
        )]),
        host: 'codex',
        status: 'failed',
        target: options.target,
      });
    }
    version = versionFrom(`${probe.stdout}\n${probe.stderr}`);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      return Object.freeze({
        diagnostics: freezeDiagnostics([diagnostic(
          'AB6033',
          'Codex CLI version probe could not be started.',
          'error',
          options.target,
          'Verify the Codex executable permissions and runtime dependencies, then rerun artifact validation.',
        )]),
        host: 'codex',
        status: 'failed',
        target: options.target,
      });
    }
    return Object.freeze({
      diagnostics: freezeDiagnostics([diagnostic(
        'AB6030',
        'The Codex CLI is not installed or is not on PATH; host artifact validation was skipped.',
        'info',
        options.target,
        'Install Codex and ensure `codex` is on PATH, then rerun artifact validation.',
      )]),
      host: 'codex',
      status: 'unavailable',
      target: options.target,
    });
  }

  const diagnostics = freezeDiagnostics([
    diagnostic(
      'AB6030',
      `Codex ${version ?? 'unknown'} does not publish a plugin validation command; ` +
        `bundle documents were checked locally against vendored pinned Codex ${pinnedRevision} schemas.`,
      'info',
      options.target,
      'Use the vendored pinned schema diagnostics until Codex publishes a plugin validation developer tool.',
    ),
    ...await validateCodexPluginFiles({ pluginDirectory, target: options.target }),
    ...await runWithPlatform(schemaGenerationDiagnostics({
      cwd,
      executable,
      run,
      strict: options.strict === true,
      target: options.target,
      version,
    })),
  ]);
  const failed = diagnostics.some((entry) => entry.severity === 'error');
  const warnings = diagnostics.some((entry) => entry.severity === 'warning');
  return Object.freeze({
    diagnostics,
    host: 'codex',
    status: failed ? 'failed' : warnings ? 'warnings' : 'passed',
    target: options.target,
    ...(version === undefined ? {} : { version }),
  });
};
