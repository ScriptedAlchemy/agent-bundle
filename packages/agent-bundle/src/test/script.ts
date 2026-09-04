/**
 * The script dispatch proof level.
 *
 * `runScript` runs one conventional `src/scripts/<name>` module through the
 * contract its generated `scripts/<name>.mjs` executable carries (#102):
 *
 * - a rendered `.tsx` script runs through the rendered-script shell
 *   (`runGeneratedRenderedScript`) — the same `--json` / `--ndjson`
 *   reservation, TTY progress, piped Markdown, and exit-code mapping the
 *   executable applies — over an in-process render session that shares the
 *   route-unit harness's dispatcher and Flight renderer;
 * - a plain `.ts` script runs as its own Node process over the source
 *   itself: the generated envelope evaluates the module (afresh, every run),
 *   awaits a `main` export with argv, adopts a numeric return as the exit
 *   code, or simply lets a self-executing module run. `process.argv`,
 *   `process.exit`, `process.chdir`, the exit code, and the streams are the
 *   real process's; an escaped rejection takes Node's top-level failure path.
 *
 * It does **not** bundle the script or touch a host artifact: no
 * `scripts/<name>.mjs`, no `-flight.mjs` worker sibling. The packed CLI
 * route suite owns that evidence.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';

import { scanEntryExports } from '../build/entry-exports.ts';
import { terminalCapabilityRuntimePath } from '../build/entry-shell.ts';
import { metaModuleSpecifier } from '../build/meta.ts';
import { runGeneratedRenderedScript } from '../cli-entry.ts';
import type { CliRenderedEvent } from '../cli-entry.ts';
import { typeScriptTransformFlags } from '../core/runtime.ts';
import { testMetaModuleSource } from '../rstest/meta-module.ts';
import { createProviderProcessLifetime } from '../routes/provider-execution.ts';
import { AgentTestError, captured } from './errors.ts';
import {
  SCRIPT_DISPATCH_PROOF_LEVEL,
  type AgentBundleTestManifest,
  type TestableScriptDescriptor,
} from './manifest.ts';
import { parseCanonicalJsonLine, parseRenderedEventLines } from './output-modes.ts';
import { registeredRouteLoader, testManifest } from './registry.ts';
import {
  prepareScriptRenderHost,
  type HarnessOptionsArguments,
  type RenderRouteContextInit,
} from './render.ts';
import { harnessTerminal } from './terminal.ts';
import type { AgentRouteModule, RenderedRouteProvenance } from './types.ts';

export interface RunScriptOptionsBase {
  readonly manifest?: AgentBundleTestManifest;
  readonly signal?: AbortSignal;
  /**
   * Input piped to a plain script's stdin, ended after the last byte. Omitted,
   * the script reads end-of-file at once. A generated executable inherits the
   * invoking terminal's stdin; a test names its input instead. Plain scripts
   * only.
   */
  readonly stdin?: string;
  /**
   * Selects interactive rendered output explicitly. Generated executables
   * probe `process.stdout`; the in-process harness defaults to piped output.
   * The same knob shapes the `request.terminal` the script observes (#511):
   * a synthetic 80×24 basic-color terminal on both streams, or two
   * color-free pipes. Rendered scripts only; a plain script's `main` receives
   * the real child process's probe.
   */
  readonly tty?: boolean;
}

/**
 * Run options. `context` carries the request-scope overrides for a rendered
 * script over the runtime's request contract (see {@link RenderRouteContextInit}):
 * omitted, the harness mounts the project's `src/providers/*` with the
 * `script` invocation exactly as the generated executable does before the
 * component renders, and `context.providers` substitutes a fixture map. A
 * plain script has no request scope and accepts no `context`.
 */
export type RunScriptOptions = RunScriptOptionsBase & RenderRouteContextInit;

/** How one script module executed at this level. */
export type ScriptExecution = 'main-envelope' | 'rendered-shell' | 'self-executing';

export interface ScriptDispatchProvenance extends Pick<RenderedRouteProvenance, 'manifestDigest' | 'projectRoot'> {
  readonly execution: ScriptExecution;
  readonly proofLevel: typeof SCRIPT_DISPATCH_PROOF_LEVEL;
  /** Every conventional script the graph compiled, so a lookup failure can name the alternatives. */
  readonly scripts: readonly string[];
}

export interface ScriptInvocation {
  /** The argv vector as dispatched; for rendered scripts this still includes the `--json` / `--ndjson` mode flags. */
  readonly argv: readonly string[];
  /**
   * The process status the contract mapped: rendered scripts exit 0 on a
   * `success` document and 1 otherwise (2 for conflicting mode flags); plain
   * scripts report their process's exit status — a numeric `main` return, an
   * assigned `process.exitCode`, a `process.exit` call, 1 after an escaped
   * rejection, or 128 + the signal number when a signal ended the process.
   */
  readonly exitCode: number;
  readonly kind: 'plain' | 'rendered';
  readonly name: string;
  readonly provenance: ScriptDispatchProvenance;
  readonly routeId: string;
  /** Everything the script wrote to its diagnostic stream. */
  readonly stderr: string;
  /** Everything the script wrote to stdout, including rendered Markdown, TTY, JSON, or NDJSON output. */
  readonly stdout: string;
  /** Rendered scripts: the completed document value the shell passed through. Absent for plain scripts. */
  readonly value?: unknown;
}

const scriptNames = (manifest: AgentBundleTestManifest): readonly string[] =>
  Object.freeze(manifest.scripts.map((script) => script.name));

const provenanceOf = (
  manifest: AgentBundleTestManifest,
  execution: ScriptExecution,
): ScriptDispatchProvenance => Object.freeze({
  execution,
  manifestDigest: manifest.digest,
  proofLevel: SCRIPT_DISPATCH_PROOF_LEVEL,
  projectRoot: manifest.projectRoot,
  scripts: scriptNames(manifest),
});

const routeProvenance = (
  manifest: AgentBundleTestManifest,
  script: TestableScriptDescriptor,
): RenderedRouteProvenance => Object.freeze({
  kind: 'script',
  manifestDigest: manifest.digest,
  modulePath: script.source,
  projectRoot: manifest.projectRoot,
  proofLevel: SCRIPT_DISPATCH_PROOF_LEVEL,
  relativePath: script.relativePath,
  routeId: script.routeId,
  source: 'manifest',
  targets: manifest.targets,
});

const compilerDetail = (manifest: AgentBundleTestManifest): readonly string[] => manifest.diagnostics.length === 0
  ? []
  : [`compiler:     ${String(manifest.diagnostics.length)} diagnostic(s), first ${manifest.diagnostics[0]!.code}: ${manifest.diagnostics[0]!.message}`];

const resolveScript = (manifest: AgentBundleTestManifest, name: string): TestableScriptDescriptor => {
  const script = manifest.scripts.find((candidate) => candidate.name === name || candidate.routeId === name);
  if (script !== undefined) return script;
  const names = scriptNames(manifest);
  throw new AgentTestError(
    'script-not-found',
    names.length === 0
      ? 'This project compiled no conventional scripts.'
      : `No compiled conventional script is named ${JSON.stringify(name)}.`,
    {
      details: [
        `project root: ${manifest.projectRoot}`,
        `compiled:     ${names.length === 0 ? 'no src/scripts/* modules' : names.join(', ')}`,
        ...compilerDetail(manifest),
      ],
      recovery: names.length === 0
        ? 'Add a module under src/scripts/ (a plain .ts exporting main, or a rendered .tsx component). Explicit scripts: configuration entries are bundled entries, not routes; the packed pool proves those.'
        : 'Run one of the compiled script names, or its script:<name> route id.',
    },
  );
};

/**
 * The registered loader for one script, resolved before any user code runs:
 * a missing loader is harness wiring, reported as such, never as the
 * script's own failure.
 */
const loaderFor = (
  manifest: AgentBundleTestManifest,
  script: TestableScriptDescriptor,
): (() => Promise<AgentRouteModule>) => {
  const loader = registeredRouteLoader(manifest, script.routeId);
  if (loader === undefined) {
    throw new AgentTestError(
      'manifest-unavailable',
      `Script ${script.name} is compiled but no test-time module loader is registered for it.`,
      {
        provenance: routeProvenance(manifest, script),
        recovery: 'Build the Rstest configuration with agentBundleRstest() so the generated setup registers script loaders.',
      },
    );
  }
  return loader;
};

/**
 * The compiled source of a plain script, confirmed present before a process
 * is started: a manifest that names a module the tree no longer holds is
 * harness wiring (a stale graph), reported as such rather than as the
 * script's own module-not-found failure.
 */
const plainSourceFor = async (
  manifest: AgentBundleTestManifest,
  script: TestableScriptDescriptor,
): Promise<string> => {
  try {
    await access(script.source);
    return script.source;
  } catch (cause) {
    throw new AgentTestError(
      'manifest-unavailable',
      `Script ${script.name} is compiled but its source ${script.source} is not on disk.`,
      {
        cause,
        provenance: routeProvenance(manifest, script),
        recovery: 'Recompile the test manifest against the current tree, or restore the module the manifest names.',
      },
    );
  }
};

/** The status a shell reports for a process: its exit code, or 128 + the number of the signal that ended it. */
const processStatus = (code: number | null, signal: NodeJS.Signals | null): number => {
  if (signal !== null) return 128 + (osConstants.signals[signal] ?? 0);
  return code ?? 1;
};

/**
 * `@rsbuild/core` as the child resolves it: its bundled SWC lowers a `.tsx`
 * or `.jsx` module the way the production Rslib profile does (automatic
 * React runtime), so a plain script may import the same helpers its bundle
 * would.
 */
const rsbuildCorePath = ((): string | undefined => {
  try {
    return createRequire(import.meta.url).resolve('@rsbuild/core');
  } catch {
    return undefined;
  }
})();

/**
 * The child process's module hooks, preloaded through `--import` as source:
 * `agent-bundle/meta` resolves to the identity module the Rstest pool serves
 * (the build's generated module over the manifest's plugin identity, or the
 * AB4760 module when the compiler pass produced no model), relative `.js` specifiers that name TypeScript sources resolve to
 * them (as the bundler resolves them for the generated executable), Node's
 * own TypeScript loading handles `.ts` (see `typeScriptTransformFlags`), and
 * `.tsx` / `.jsx` lower through the bundler's SWC.
 */
const hooksSource = (manifest: AgentBundleTestManifest): string => `
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const metaSpecifier = ${JSON.stringify(metaModuleSpecifier)};
const metaUrl = 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(testMetaModuleSource(manifest))});
const rsbuildCore = ${JSON.stringify(rsbuildCorePath ?? null)};
// JSX in a dependency, in TypeScript (.tsx) or JavaScript (.jsx): the build
// lowers both through the React plugin, Node on its own loads neither.
const lowerJsx = (filename, source) => {
  if (rsbuildCore === null) {
    throw new Error('Cannot load ' + filename + ': the harness could not resolve @rsbuild/core to lower JSX.');
  }
  return createRequire(rsbuildCore)(rsbuildCore).rspack.experiments.swc.transformSync(source, {
    filename,
    isModule: true,
    jsc: {
      parser: filename.endsWith('.tsx') ? { syntax: 'typescript', tsx: true } : { syntax: 'ecmascript', jsx: true },
      target: 'es2022',
      transform: { react: { runtime: 'automatic' } },
    },
    module: { type: 'es6' },
    sourceMaps: false,
  }).code;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === metaSpecifier) return { shortCircuit: true, url: metaUrl };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relativeJs = /^\\.\\.?\\/.*\\.[cm]?js$/u.test(specifier);
      if (error !== null && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND' && relativeJs && context.parentURL !== undefined) {
        for (const extension of ['.ts', '.tsx', '.mts', '.cts']) {
          const candidate = specifier.replace(/\\.[cm]?js$/u, extension);
          const url = new URL(candidate, context.parentURL);
          if (url.protocol === 'file:' && existsSync(fileURLToPath(url))) return nextResolve(candidate, context);
        }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !(url.endsWith('.tsx') || url.endsWith('.jsx'))) return nextLoad(url, context);
    const filename = fileURLToPath(url);
    return { format: 'module', shortCircuit: true, source: lowerJsx(filename, readFileSync(filename, 'utf8')) };
  },
});
`;

/**
 * The generated process envelope, as the child's entry: the same statements
 * `generatedExecutableEntrySource` emits into `scripts/<name>.mjs`, over the
 * source module named by `process.argv[1]`.
 */
const envelopeSource = (execution: ScriptExecution): string => [
  "import { pathToFileURL } from 'node:url';",
  // The generated executable inlines the terminal probe through a bundler
  // alias; the child imports the same module from the package instead.
  ...(execution === 'main-envelope'
    ? [`import { detectProcessTerminal } from ${JSON.stringify(pathToFileURL(terminalCapabilityRuntimePath()).href)};`]
    : []),
  '',
  // A generated `scripts/<name>.mjs` runs under plain `node <file>`: the
  // loader flags this launch needs are the harness's, not the script's.
  'process.execArgv = [];',
  'const source = process.argv[1];',
  'const entry = await import(pathToFileURL(source).href);',
  ...(execution === 'main-envelope'
    ? [
      'const main = entry.main;',
      "if (typeof main !== 'function') {",
      "  throw new TypeError('Executable entry must export a main function: ' + source);",
      '}',
      "const code = await main(process.argv.slice(2), Object.freeze({ terminal: detectProcessTerminal('script') }));",
      "if (typeof code === 'number') process.exitCode = code;",
    ]
    : []),
  '',
].join('\n');

interface PlainRunResult {
  readonly execution: ScriptExecution;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * How long an aborted script may take to leave after SIGTERM before it is
 * killed: a script that traps the signal must still not outlive its run.
 */
const TERMINATION_GRACE_MS = 1000;

const runPlainScript = async (
  manifest: AgentBundleTestManifest,
  script: TestableScriptDescriptor,
  argv: readonly string[],
  stdin: string | undefined,
  signal: AbortSignal,
): Promise<PlainRunResult> => {
  signal.throwIfAborted();
  const source = await plainSourceFor(manifest, script);
  // The builder decides the envelope statically, before the module ever
  // runs; the same scan decides here so a non-callable `main` export fails
  // the way the generated executable fails instead of passing as a
  // self-executing module.
  const execution: ScriptExecution = (await scanEntryExports(source)).hasMainExport
    ? 'main-envelope'
    : 'self-executing';
  // An abort that landed while the source was being resolved and scanned is
  // not replayed to a listener added afterwards; checked here, with nothing
  // asynchronous between the check, the spawn, and the listener, no process
  // can start without the abort reaching it.
  signal.throwIfAborted();
  // A generated executable runs under plain `node`; the test runner's own
  // flags are not inherited, only the TypeScript loading the source needs —
  // the transform flag where this Node still has one (22, 24), `--strip-types`
  // on Node 26, which rejects the old flag and only strips types.
  const child = spawn(process.execPath, [
    ...typeScriptTransformFlags(),
    '--disable-warning=ExperimentalWarning',
    '--import', `data:text/javascript,${encodeURIComponent(hooksSource(manifest))}`,
    '--input-type=module',
    '--eval', envelopeSource(execution),
    '--',
    source,
    ...argv,
  ], { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (child.stdin !== null) {
    // The script may exit without reading; a closed pipe is not the run's failure.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  }
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
  // Abort asks the process to leave as an operator would, then makes sure it
  // has: the run settles only once the process is gone, so a script that
  // traps SIGTERM cannot outlive its test.
  let escalation: NodeJS.Timeout | undefined;
  const terminate = (): void => {
    child.kill('SIGTERM');
    escalation = setTimeout(() => { child.kill('SIGKILL'); }, TERMINATION_GRACE_MS);
    escalation.unref();
  };
  signal.addEventListener('abort', terminate, { once: true });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, ended) => { resolve(processStatus(code, ended)); });
    });
    signal.throwIfAborted();
    return Object.freeze({ execution, exitCode: status, stderr: err, stdout: out });
  } finally {
    signal.removeEventListener('abort', terminate);
    if (escalation !== undefined) clearTimeout(escalation);
  }
};

const rejectRenderedOnlyOptions = (
  manifest: AgentBundleTestManifest,
  script: TestableScriptDescriptor,
  options: RunScriptOptions,
): void => {
  // A plain script opens no request scope: no providers are mounted for it,
  // so there is nothing for `context` — fixtures included — to override.
  const offending = [
    ...(options.context === undefined ? [] : ['context']),
    ...(options.tty === undefined ? [] : ['tty']),
  ];
  if (offending.length === 0) return;
  throw new AgentTestError(
    'invalid-input',
    `Plain script ${script.name} has no render session; ${offending.join(' and ')} apply to rendered (.tsx) scripts only.`,
    {
      provenance: routeProvenance(manifest, script),
      recovery: 'Drop the rendered-only options, or rename the script to .tsx to render it through the Agent renderer.',
    },
  );
};

type StreamWrite = typeof process.stdout.write;

/**
 * What a rendered run stands in for: the generated executable's render
 * worker. Its stdout and stderr are both forwarded onto the executable's
 * stderr, so machine output owns stdout and a `console.log` in a route never
 * reaches it; and `process.exit` in worker code ends the worker — the shell
 * sees its pending render fail with the exit — never the executable itself.
 * In this process the render happens on the test worker's own streams and
 * `process`; while a rendered run is under way, writes and exits made in its
 * async context go to the run, and those from anywhere else pass through
 * untouched, so rendered runs may overlap other tests.
 */
interface RenderedWorker {
  /** Set once the worker "exited": nothing it writes afterwards exists. */
  exited: boolean;
  readonly onExit: (code: number) => void;
  readonly sink: (text: string) => void;
}

const renderedWorker = new AsyncLocalStorage<RenderedWorker>();
let capturingRenders = 0;

/** The failure the generated executable's shell reports when its render worker exits mid-render. */
export const renderWorkerExited = (code: number): string => `Generated render worker exited with code ${String(code)}.`;

const routedExit = (original: typeof process.exit): typeof process.exit => function exit(
  this: unknown,
  code?: number | string | null,
): never {
  const worker = renderedWorker.getStore();
  if (worker === undefined) return Reflect.apply(original, process, [code]) as never;
  const numeric = code === undefined || code === null ? 0 : Number(code);
  if (!worker.exited) {
    worker.exited = true;
    worker.onExit(numeric);
  }
  // Worker code never runs past its `process.exit`; here the call unwinds the
  // caller instead. Should the caller catch that and carry on, the worker has
  // already gone: the run has failed and its further output is discarded.
  throw new Error(renderWorkerExited(numeric));
};

const routedWrite = (original: StreamWrite, stream: NodeJS.WriteStream): StreamWrite => function write(
  this: unknown,
  chunk: Uint8Array | string,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
): boolean {
  const worker = renderedWorker.getStore();
  if (worker === undefined) {
    return Reflect.apply(original, stream, [chunk, encodingOrCallback, callback]) as boolean;
  }
  const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
  if (!worker.exited) worker.sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding));
  const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  done?.(null);
  return true;
};

const consoleMethods = ['debug', 'error', 'info', 'log', 'trace', 'warn'] as const;
type ConsoleMethod = (typeof consoleMethods)[number];
type ConsoleWrite = (...data: unknown[]) => void;

/**
 * A console method that, inside a rendered run, formats onto the run's sink
 * the way Node's console formats onto its stream, and otherwise defers to
 * whatever the method was — a test runner commonly installs its own.
 */
const routedConsole = (method: ConsoleMethod, original: ConsoleWrite): ConsoleWrite => (...data) => {
  const worker = renderedWorker.getStore();
  if (worker === undefined) {
    original(...data);
    return;
  }
  if (!worker.exited) worker.sink(`${format(...data)}\n`);
};

interface UnpatchedProcess {
  readonly console: Readonly<Record<ConsoleMethod, ConsoleWrite>>;
  readonly err: StreamWrite;
  readonly exit: typeof process.exit;
  readonly out: StreamWrite;
}

let unpatchedProcess: UnpatchedProcess | undefined;

const withRenderedWorker = async <T>(
  worker: Readonly<Pick<RenderedWorker, 'onExit' | 'sink'>>,
  run: () => Promise<T>,
): Promise<T> => {
  if (capturingRenders === 0) {
    const out = process.stdout.write;
    const err = process.stderr.write;
    const exit = process.exit;
    const methods = Object.fromEntries(consoleMethods.map((method) => [method, console[method] as ConsoleWrite]));
    unpatchedProcess = { console: methods as Record<ConsoleMethod, ConsoleWrite>, err, exit, out };
    process.stdout.write = routedWrite(out, process.stdout);
    process.stderr.write = routedWrite(err, process.stderr);
    process.exit = routedExit(exit);
    for (const method of consoleMethods) console[method] = routedConsole(method, methods[method]!);
  }
  capturingRenders += 1;
  try {
    return await renderedWorker.run({ exited: false, onExit: worker.onExit, sink: worker.sink }, run);
  } finally {
    capturingRenders -= 1;
    if (capturingRenders === 0 && unpatchedProcess !== undefined) {
      process.stdout.write = unpatchedProcess.out;
      process.stderr.write = unpatchedProcess.err;
      process.exit = unpatchedProcess.exit;
      for (const method of consoleMethods) console[method] = unpatchedProcess.console[method];
      unpatchedProcess = undefined;
    }
  }
};

const rejectPlainOnlyOptions = (
  manifest: AgentBundleTestManifest,
  script: TestableScriptDescriptor,
  options: RunScriptOptions,
): void => {
  if (options.stdin === undefined) return;
  throw new AgentTestError(
    'invalid-input',
    `Rendered script ${script.name} renders in this process and reads no stdin; stdin applies to plain (.ts) scripts only.`,
    {
      provenance: routeProvenance(manifest, script),
      recovery: 'Drop stdin, or pass the input as argv; a rendered script receives its input as { argv }.',
    },
  );
};

/**
 * Runs one conventional script through its generated-executable contract —
 * a rendered script in this process, a plain script as a Node process of its
 * own over the source — and returns its exit code, streams, and (for
 * rendered scripts) the completed document value.
 *
 * This is the `script-dispatch` proof level. Nothing is bundled.
 */
export const runScript = async (
  name: string,
  argv: readonly string[] = [],
  ...[options = {}]: HarnessOptionsArguments<RunScriptOptions>
): Promise<ScriptInvocation> => {
  const manifest = options.manifest ?? testManifest();
  const script = resolveScript(manifest, name);
  const signal = options.signal ?? new AbortController().signal;
  const frozenArgv = Object.freeze([...argv]);

  if (!script.rendered) {
    rejectRenderedOnlyOptions(manifest, script, options);
    const plain = await runPlainScript(manifest, script, frozenArgv, options.stdin, signal);
    return Object.freeze({
      argv: frozenArgv,
      exitCode: plain.exitCode,
      kind: 'plain',
      name: script.name,
      provenance: provenanceOf(manifest, plain.execution),
      routeId: script.routeId,
      stderr: plain.stderr,
      stdout: plain.stdout,
    });
  }

  const provenance = routeProvenance(manifest, script);
  rejectPlainOnlyOptions(manifest, script, options);
  // Resolving the loader is harness wiring; loading the module is user code
  // and happens only when the shell opens a session, after its argv checks.
  const loadModule = loaderFor(manifest, script);
  let value: unknown;
  let out = '';
  let err = '';
  const host = await prepareScriptRenderHost({
    ...(options.context === undefined ? {} : { context: options.context }),
    loadModule,
    manifest,
    name: script.name,
    onComplete: (completed) => { value = completed; },
    // Each generated `scripts/<name>.mjs` is a process of its own: its
    // providers see hit 1 of a fresh identity on every run.
    processLifetime: createProviderProcessLifetime(),
    provenance,
    signal,
  });
  let exitCode: number;
  try {
    exitCode = await withRenderedWorker({
      // `process.exit` in the render worker ends it; the shell's pending
      // render fails with the exit and the shell reports that failure.
      onExit: (code) => { host.terminate(new Error(renderWorkerExited(code))); },
      sink: (text) => { err += text; },
    }, () => runGeneratedRenderedScript({
      argv: frozenArgv,
      createSession: host.createSession,
      name: script.name,
      signal,
      terminal: harnessTerminal('script', options.tty === true),
      writeErr: (text) => { err += text; },
      writeOut: (text) => { out += text; },
    }));
  } finally {
    await host.close();
  }
  return Object.freeze({
    argv: frozenArgv,
    exitCode,
    kind: 'rendered',
    name: script.name,
    provenance: provenanceOf(manifest, 'rendered-shell'),
    routeId: script.routeId,
    stderr: err,
    stdout: out,
    ...(value === undefined ? {} : { value }),
  });
};

const outputFailure = (
  invocation: ScriptInvocation,
  message: string,
  recovery: string,
  cause: unknown,
): AgentTestError => new AgentTestError('projection-failed', message, {
  cause,
  details: [
    `exit code:    ${String(invocation.exitCode)}`,
    `execution:    ${invocation.provenance.execution}`,
    `stdout:       ${captured(invocation.stdout)}`,
    ...(invocation.stderr === '' ? [] : [`stderr:       ${captured(invocation.stderr)}`]),
  ],
  provenance: {
    kind: 'script',
    manifestDigest: invocation.provenance.manifestDigest,
    projectRoot: invocation.provenance.projectRoot,
    proofLevel: SCRIPT_DISPATCH_PROOF_LEVEL,
    routeId: invocation.routeId,
    source: 'manifest',
    targets: [],
  },
  recovery,
});

/** The parsed canonical JSON line a successful `--json` rendered-script run wrote to stdout. */
export const scriptJson = (invocation: ScriptInvocation): unknown => {
  try {
    return parseCanonicalJsonLine(invocation.stdout);
  } catch (error) {
    throw outputFailure(
      invocation,
      'The dispatched script did not write one canonical JSON line to stdout.',
      'Call scriptJson() only for a rendered script run that passed --json and completed; plain scripts write whatever their main function wrote.',
      error,
    );
  }
};

/** The ordered render events a successful `--ndjson` rendered-script run wrote to stdout. */
export const scriptNdjson = (invocation: ScriptInvocation): readonly CliRenderedEvent[] => {
  try {
    return parseRenderedEventLines(invocation.stdout);
  } catch (error) {
    throw outputFailure(
      invocation,
      'The dispatched script did not write one JSON object per line to stdout.',
      'Call scriptNdjson() only for a rendered script run that passed --ndjson and wrote a complete event stream.',
      error,
    );
  }
};
