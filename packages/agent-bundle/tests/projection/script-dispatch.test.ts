import { dirname } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import {
  AgentTestError,
  runScript,
  scriptJson,
  scriptNdjson,
  testManifest,
} from '../../src/test/index.ts';
import { FALLBACK_PLUGIN_IDENTITY } from '../../src/test/manifest.ts';

const summaryValue = (...argv: string[]) => ({
  arguments: argv,
  invocation: 'script',
  stateMounted: true,
  surface: 'summary',
});

describe('the compiled script inventory', () => {
  it('lists every conventional script with its extension contract', () => {
    expect(testManifest().scripts.map((script) => [script.name, script.rendered])).toEqual([
      ['badge', false],
      ['banner', false],
      ['blank', true],
      ['broken', true],
      ['checksum', false],
      ['constant', false],
      ['identity', false],
      ['stalled', true],
      ['summary', true],
      ['tooling-summary', true],
    ]);
  });

  it('names the compiled alternatives when a script is unknown', async () => {
    const error = await runScript('missing').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('script-not-found');
    expect((error as AgentTestError).message).toContain('compiled:     badge, banner, blank, broken, checksum, constant, identity, stalled, summary, tooling-summary');
    expect((error as AgentTestError).message).toContain(`project root: ${testManifest().projectRoot}`);
  });
});

describe('rendered scripts at the script dispatch level', () => {
  it('routes what the component logs onto the invocation\'s stderr, as the executable forwards its render worker', async () => {
    // Anything escaping the run would land on this process's streams.
    const escaped: string[] = [];
    const outBefore = process.stdout.write;
    const errBefore = process.stderr.write;
    const record = (chunk: unknown): boolean => { escaped.push(String(chunk)); return true; };
    process.stdout.write = record as typeof process.stdout.write;
    process.stderr.write = record as typeof process.stderr.write;
    try {
      const run = await runScript('summary', ['--json', '--log']);

      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(summaryValue('--log'));
      expect(run.stderr).toBe('summary log line\nsummary stdout line\nsummary stderr line\n');
      expect(escaped).toEqual([]);
      // The run restored this process's streams.
      expect(process.stdout.write).toBe(record);
      expect(process.stderr.write).toBe(record);
      // And a write outside any run still passes through untouched.
      process.stdout.write('outside any run\n');
      expect(escaped).toEqual(['outside any run\n']);
    } finally {
      process.stdout.write = outBefore;
      process.stderr.write = errBefore;
    }
  });

  it('reports process.exit from rendered code as the worker exit the executable\'s shell reports, and keeps this process alive', async () => {
    // The generated executable renders in a worker: `process.exit` there ends
    // the worker, the shell's pending render fails with the exit, and the
    // shell reports it with exit code 1 — whatever the code was, 0 included.
    const exitBefore = process.exit;
    const three = await runScript('summary', ['--json', '--exit=3']);
    expect(three.exitCode).toBe(1);
    expect(three.stdout).toBe('');
    expect(three.stderr).toBe('Generated render worker exited with code 3.\n');
    expect(three.value).toBeUndefined();

    const zero = await runScript('summary', ['--exit=0']);
    expect(zero.exitCode).toBe(1);
    expect(zero.stderr).toBe('Generated render worker exited with code 0.\n');

    // The run restored this process's exit, and the next run is unaffected.
    expect(process.exit).toBe(exitBefore);
    const after = await runScript('summary', ['--json', 'after-exit']);
    expect(after.exitCode).toBe(0);
    expect(scriptJson(after)).toEqual(summaryValue('after-exit'));
  });

  it('holds a process.exit the rendered code catches: the worker is gone, so the run fails and later output is discarded', async () => {
    const run = await runScript('summary', ['--json', '--exit=5', '--catch-exit']);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('Generated render worker exited with code 5.\n');
    expect(run.value).toBeUndefined();
  });

  it('projects a rendered script to final Markdown when stdout is piped', async () => {
    const run = await runScript('summary', ['alpha', 'beta']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('# Summary\n\n2 argument(s).\n\nsurface: summary\n');
    expect(run.stdout).not.toContain('collecting arguments');
    expect(run.value).toEqual(summaryValue('alpha', 'beta'));
    expect(run).toMatchObject({
      kind: 'rendered',
      name: 'summary',
      provenance: { execution: 'rendered-shell', proofLevel: 'script-dispatch', scripts: ['badge', 'banner', 'blank', 'broken', 'checksum', 'constant', 'identity', 'stalled', 'summary', 'tooling-summary'] },
      routeId: 'script:summary',
    });
  });

  it('updates rendered progress in place for an explicit TTY', async () => {
    const run = await runScript('summary', ['alpha'], { tty: true });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('\r\u001B[2Kcollecting arguments (1/2)');
    expect(run.stdout).toContain('\r\u001B[2Ksummary ready (2/2)');
    expect(run.stdout.endsWith('# Summary\n\n1 argument(s).\n\nsurface: summary\n')).toBe(true);
  });

  it('reserves --json for the canonical value and passes every other argument through', async () => {
    const run = await runScript('summary', ['alpha', '--json', '--verbose']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe(`${JSON.stringify(summaryValue('alpha', '--verbose'))}\n`);
    expect(scriptJson(run)).toEqual(summaryValue('alpha', '--verbose'));
    // The dispatched argv is reported as given; the component saw the reserved flag removed.
    expect(run.argv).toEqual(['alpha', '--json', '--verbose']);
  });

  it('passes reserved flags through untouched after a -- terminator', async () => {
    const run = await runScript('summary', ['--json', '--', '--ndjson']);

    expect(run.exitCode).toBe(0);
    expect(scriptJson(run)).toEqual(summaryValue('--', '--ndjson'));
  });

  it('returns the pure sequence-numbered render-event stream as NDJSON', async () => {
    const run = await runScript('summary', ['alpha', '--ndjson']);
    const events = scriptNdjson(run);
    const sequences = events.map((event) => event.sequence);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]!)).toBe(true);
    expect(events.some((event) => event.type === 'progress')).toBe(true);
    expect(events.at(-1)).toMatchObject({
      document: { status: 'success', value: summaryValue('alpha') },
      type: 'complete',
    });
    expect(JSON.stringify(events)).not.toContain('"jsonrpc"');
    expect(run.stdout.trim().split('\n')).toHaveLength(events.length);
  });

  it('exits 1 for a represented error document and projects the error node to Markdown', async () => {
    const run = await runScript('summary', ['--fail']);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('**[summary.failed]** The summary was asked to fail.\n');
    expect(run.value).toEqual(summaryValue('--fail'));
  });

  it('reports a component render error on stderr', async () => {
    const run = await runScript('summary', ['--explode']);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    // The renderer logs the thrown error with its stack (the render worker's
    // console, forwarded onto stderr in the generated executable), then the
    // shell reports the failure message.
    expect(run.stderr).toMatch(/^Error: summary render exploded\n {4}at Summary \(/u);
    expect(run.stderr).toMatch(/\nsummary render exploded\n$/u);
  });

  it('reports cancellation through the shell after rendered progress begins', async () => {
    const controller = new AbortController();
    const run = await runScript('summary', ['--wait-for-abort'], {
      context: { progress: { report: async () => controller.abort() } },
      signal: controller.signal,
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Aborted.');
  });

  it('reports cancellation while the module is still loading, as the executable fails its stream and drops the worker', async () => {
    // `stalled` never finishes evaluating; without the abort the run could not end.
    const controller = new AbortController();
    const pending = runScript('stalled', ['--json'], { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const run = await pending;

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('Aborted.\n');
    expect(run.value).toBeUndefined();
  }, 5000);

  it('mounts the conventional providers for a rendered script with the script invocation, as the generated executable does', async () => {
    type Summary = { arguments: number; keys: string[]; libraryTooling: unknown };
    const first = await runScript('tooling-summary', ['--json', 'a.mp4', '--fast']);
    const second = await runScript('tooling-summary', ['--json', 'b.mp4']);

    expect(first.exitCode).toBe(0);
    // The generated script passes `name: 'tooling-summary'`, never the route id.
    expect(scriptJson(first)).toEqual({
      arguments: 2,
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'script', surface: 'tooling-summary', tool: 'ffprobe 6.1' },
    });
    expect((scriptJson(second) as Summary).arguments).toBe(1);

    // An explicit fixture map is mounted verbatim: nothing under
    // src/providers/ runs for this invocation.
    const stubbed = await runScript('tooling-summary', ['--json', 'c.mp4'], {
      context: { providers: { libraryTooling: { tool: 'stub' }, processLifetime: { hits: 7, instanceId: 'fixture', pid: 0 } } },
    });
    expect(scriptJson(stubbed)).toEqual({
      arguments: 1,
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { tool: 'stub' },
    });
  });

  it('rejects conflicting output flags at the shell boundary', async () => {
    const run = await runScript('summary', ['--json', '--ndjson']);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('Use either --json or --ndjson, not both.\n');
  });

  it('rejects Markdown as canonical JSON or NDJSON with diagnostics naming the level and route', async () => {
    const run = await runScript('summary', ['alpha']);

    for (const [accessor, fragment] of [
      [scriptJson, 'did not write one canonical JSON line'],
      [scriptNdjson, 'did not write one JSON object per line'],
    ] as const) {
      const error = ((): unknown => {
        try {
          return accessor(run);
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error).toBeInstanceOf(AgentTestError);
      expect((error as AgentTestError).message).toContain(fragment);
      expect((error as AgentTestError).message).toContain('proof level:  script-dispatch');
      expect((error as AgentTestError).message).toContain('route:        script:summary (script)');
      expect((error as AgentTestError).message).toContain('execution:    rendered-shell');
    }
  });
});

describe('plain scripts at the script dispatch level', () => {
  it('runs a main-exporting script through the process envelope contract', async () => {
    const stdoutWrite = process.stdout.write;
    const run = await runScript('checksum', ['ab', 'cde']);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('Fixture checksum: 5\n');
    expect(run.stderr).toBe('');
    expect(run.value).toBeUndefined();
    expect(run).toMatchObject({
      kind: 'plain',
      name: 'checksum',
      provenance: { execution: 'main-envelope', proofLevel: 'script-dispatch' },
      routeId: 'script:checksum',
    });
    // The script had its own process view; this one was never patched.
    expect(process.stdout.write).toBe(stdoutWrite);
  });

  it('adopts a numeric return as the exit code and keeps stderr separate', async () => {
    const run = await runScript('checksum');

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('Fixture checksum: 0\n');
    expect(run.stderr).toBe('No arguments to checksum.\n');
  });

  it('adopts an assigned process.exitCode when main returns nothing', async () => {
    const previous = process.exitCode;
    const run = await runScript('checksum', ['--exit-code-property']);

    expect(run.exitCode).toBe(4);
    expect(run.stdout).toBe('checksum set process.exitCode\n');
    expect(process.exitCode).toBe(previous);
  });

  it('turns a process.exit call into the exit code instead of ending the test process', async () => {
    const run = await runScript('checksum', ['--process-exit']);

    expect(run.exitCode).toBe(5);
    expect(run.stdout).toBe('checksum called process.exit\n');
  });

  it('exits 1 with the stack on stderr when main rejects, like the generated process', async () => {
    const run = await runScript('checksum', ['--explode']);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Error: checksum exploded');
  });

  it('reports a stale manifest as harness wiring before any user code runs', async () => {
    const compiled = testManifest();
    const checksum = compiled.scripts.find((script) => script.name === 'checksum')!;
    const ghost = {
      ...checksum,
      name: 'ghost',
      relativePath: 'src/scripts/ghost.ts',
      routeId: 'script:ghost',
      source: checksum.source.replace(/checksum\.ts$/u, 'ghost.ts'),
    };

    const error = await runScript('ghost', ['--explode'], { manifest: { ...compiled, scripts: [...compiled.scripts, ghost] } })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('manifest-unavailable');
    expect((error as AgentTestError).message).toContain('is not on disk');
    expect((error as AgentTestError).message).toContain('route:        script:ghost (script)');

    // The harness failure left nothing behind: the next plain run still
    // reports its own streams and exit code.
    const run = await runScript('checksum', ['--explode']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('Error: checksum exploded');
  });

  it('refuses rendered-only options for a plain script instead of ignoring them', async () => {
    const error = await runScript('checksum', ['ab'], { tty: true }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('invalid-input');
    expect((error as AgentTestError).message).toContain('tty apply to rendered (.tsx) scripts only');
    expect((error as AgentTestError).message).toContain('module:       src/scripts/checksum.ts');
  });

  it('evaluates a self-executing module afresh on every run, as every process would', async () => {
    const first = await runScript('banner', ['x', 'y']);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe('banner: x y\n');
    expect(first.provenance.execution).toBe('self-executing');

    const again = await runScript('banner', ['again']);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toBe('banner: again\n');

    // A manifest for another tree names modules that are not there: that is
    // harness wiring, reported before anything runs.
    const compiled = testManifest();
    const elsewhere = `${compiled.projectRoot}-sibling`;
    const sibling = {
      ...compiled,
      projectRoot: elsewhere,
      scripts: compiled.scripts.map((script) => ({ ...script, source: script.source.replace(compiled.projectRoot, elsewhere) })),
    };
    const other = await runScript('banner', ['again'], { manifest: sibling }).catch((thrown: unknown) => thrown);
    expect(other).toBeInstanceOf(AgentTestError);
    expect((other as AgentTestError).code).toBe('manifest-unavailable');
    expect((other as AgentTestError).message).toContain(`${elsewhere}/src/scripts/banner.ts is not on disk`);
  });

  it('starts a main-exporting script from fresh module state on every run', async () => {
    const source = testManifest().scripts.find((script) => script.name === 'checksum')!.source;
    const first = await runScript('checksum', ['--calls']);
    const second = await runScript('checksum', ['--calls']);

    // Module-level state does not survive between runs, and argv[1] is the
    // executable's own path, exactly as the generated process reports it.
    expect(first.stdout).toBe(`checksum call 1 in ${source}\n`);
    expect(second.stdout).toBe(`checksum call 1 in ${source}\n`);
  });

  it('lowers a .tsx helper a plain script imports, as the bundler does for the generated executable', async () => {
    const run = await runScript('badge', ['needs', 'review']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('<span class="badge">needs review</span>\n');
    expect(run.provenance.execution).toBe('main-envelope');
  });

  it('lowers a JavaScript .jsx helper imported by extension, as the bundler does', async () => {
    const run = await runScript('badge', ['--ribbon', 'needs', 'review']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('<em class="ribbon">needs review</em>\n');
  });

  it('serves agent-bundle/meta as the identity the build stamps, not the published entry that throws', async () => {
    const run = await runScript('identity');

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    // The route-harness fixture declares plugin name/version and has no package.json.
    expect(run.stdout).toBe('route-harness@1.0.0 - -\n');

    const compiled = testManifest();
    const packaged = await runScript('identity', [], {
      manifest: { ...compiled, plugin: { ...compiled.plugin, packageName: '@fixture/route-harness', packageVersion: '2.3.4' } },
    });
    expect(packaged.stdout).toBe('route-harness@1.0.0 @fixture/route-harness 2.3.4\n');

    // A manifest without a plugin model carries the frozen sentinel; the
    // script is served the same AB4760 module the Rstest pool serves, never
    // a fabricated identity.
    const modelless = await runScript('identity', [], { manifest: { ...compiled, plugin: FALLBACK_PLUGIN_IDENTITY } });
    expect(modelless.exitCode).toBe(1);
    expect(modelless.stdout).toBe('');
    expect(modelless.stderr).toContain('[AB4760]');
    expect(modelless.stderr).toContain('produced no plugin model');
  });

  it('rejects context on a plain script: it opens no request scope, so no providers are mounted for it', async () => {
    const error = await runScript('checksum', ['ab'], { context: { providers: {} } })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('invalid-input');
    expect((error as AgentTestError).message).toContain('context apply to rendered (.tsx) scripts only');
  });

  it('gives the script the process APIs a worker thread refuses, such as process.chdir, without moving this process', async () => {
    const cwd = process.cwd();
    const run = await runScript('checksum', ['--chdir']);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(`checksum cwd ${dirname(cwd)}\n`);
    expect(process.cwd()).toBe(cwd);
  });

  it('fails a non-callable main export the way the generated envelope does, after evaluating the module', async () => {
    const run = await runScript('constant', ['ignored']);

    expect(run.exitCode).toBe(1);
    expect(run.provenance.execution).toBe('main-envelope');
    expect(run.stdout).toBe('constant evaluated\n');
    expect(run.stderr).toContain(`TypeError: Executable entry must export a main function: ${testManifest().scripts.find((script) => script.name === 'constant')!.source}`);
  });
});

describe('a rendered script whose module fails to evaluate', () => {
  const loads = (): number => (globalThis as { routeHarnessBrokenLoads?: number }).routeHarnessBrokenLoads ?? 0;

  it('never evaluates the module when the shell rejects the argv first, exactly like the generated executable', async () => {
    const before = loads();
    const run = await runScript('broken', ['--json', '--ndjson']);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe('Use either --json or --ndjson, not both.\n');
    expect(loads()).toBe(before);
  });

  it('reports the load failure through the shell as stderr and exit code 1', async () => {
    const before = loads();
    const run = await runScript('broken', ['--json']);

    expect(loads()).toBe(before + 1);
    expect(run.kind).toBe('rendered');
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('broken script failed to load\n');
    expect(run.value).toBeUndefined();
    expect(run.provenance.execution).toBe('rendered-shell');
  });

  it('reports a module without a default component the same way, and still closes the mounted state', async () => {
    const run = await runScript('blank');

    expect(run.kind).toBe('rendered');
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('A route module default-exports its route component.');
    expect(run.stderr).toContain('received:     default export of type undefined');
    expect(run.value).toBeUndefined();

    // The host closed cleanly: the next rendered run mounts state again and completes.
    const next = await runScript('summary', ['--json', 'after-blank']);
    expect(next.exitCode).toBe(0);
    expect(scriptJson(next)).toEqual(summaryValue('after-blank'));
  });
});

describe('the plain-script process contract', () => {
  it('leaves this process untouched while the script runs: its argv, exit code, and streams are its own', async () => {
    const argvBefore = process.argv;
    const exitCodeBefore = process.exitCode;
    const writeBefore = process.stdout.write;
    const pending = runScript('checksum', ['abc', '--delay']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(process.argv).toBe(argvBefore);
    expect(process.exitCode).toBe(exitCodeBefore);
    expect(process.stdout.write).toBe(writeBefore);
    process.stdout.write('unrelated concurrent stdout\n');
    process.stderr.write('unrelated concurrent stderr\n');
    process.exitCode = 9;
    const run = await pending;
    process.exitCode = exitCodeBefore;

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('Fixture checksum: 3\n');
    expect(run.stderr).toBe('');
  });

  it('runs two plain scripts at once without either seeing the other\'s output', async () => {
    const [banner, checksum] = await Promise.all([
      runScript('banner', ['side', 'by', 'side']),
      runScript('checksum', ['abcd', '--delay']),
    ]);

    expect(banner.stdout).toBe('banner: side by side\n');
    expect(checksum.stdout).toBe('Fixture checksum: 4\n');
  });

  it('ends the script at process.exit even when the script catches the call and carries on', async () => {
    const run = await runScript('checksum', ['--swallow-exit']);

    expect(run.exitCode).toBe(3);
    expect(run.stdout).toBe('');
  });

  it('never hangs on work the script queued after process.exit', async () => {
    const run = await runScript('checksum', ['--exit-then-hang']);

    expect(run.exitCode).toBe(6);
    expect(run.stdout).toBe('');
  });

  it('terminates the script when the signal aborts, and reports the abort', async () => {
    const controller = new AbortController();
    const pending = runScript('checksum', ['abc', '--delay'], { signal: controller.signal });
    controller.abort(new Error('stop the script'));

    await expect(pending).rejects.toThrow('stop the script');
  });

  it('ends a script that never finishes whenever the abort lands: before, while, or after its process is started', async () => {
    // Resolving and scanning the source are asynchronous, so an abort can
    // land before the process exists, while it is being prepared, or once it
    // runs; `--hang` never exits on its own, so a missed abort would hang
    // the run. Each timing must reject with the abort reason.
    const timings: readonly ((abort: () => void) => void)[] = [
      (abort) => { abort(); },
      (abort) => { queueMicrotask(abort); },
      (abort) => { setImmediate(abort); },
      (abort) => { setTimeout(abort, 1); },
      (abort) => { setTimeout(abort, 5); },
      (abort) => { setTimeout(abort, 25); },
      (abort) => { setTimeout(abort, 150); },
    ];
    for (const [index, schedule] of timings.entries()) {
      const controller = new AbortController();
      const pending = runScript('checksum', ['--hang'], { signal: controller.signal });
      schedule(() => { controller.abort(new Error(`stop the hanging script (${String(index)})`)); });

      await expect(pending).rejects.toThrow(`stop the hanging script (${String(index)})`);
    }
  }, 15_000);

  it('reaps a script that traps SIGTERM before reporting the abort, so it cannot outlive its run', async () => {
    const controller = new AbortController();
    const pending = runScript('checksum', ['--ignore-sigterm'], { signal: controller.signal });
    // Let the script install its handler before asking it to leave.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const started = Date.now();
    controller.abort(new Error('stop the trapping script'));

    await expect(pending).rejects.toThrow('stop the trapping script');
    // SIGTERM was trapped; the run settled only after the escalation killed
    // the process, within the grace period plus scheduling slack.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);

  it('hides the harness loader flags from the script: process.execArgv is empty, as under plain node', async () => {
    const run = await runScript('checksum', ['--exec-argv']);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('checksum execArgv []\n');
  });

  it('pipes stdin to a plain script when given, and ends it at once otherwise', async () => {
    const fed = await runScript('checksum', ['--stdin'], { stdin: 'piped input\n' });
    expect(fed.exitCode).toBe(0);
    expect(fed.stdout).toBe('checksum read 12 byte(s): piped input\n');

    const empty = await runScript('checksum', ['--stdin']);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toBe('checksum read 0 byte(s): \n');

    const error = await runScript('summary', ['x'], { stdin: 'ignored' }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('invalid-input');
    expect((error as AgentTestError).message).toContain('stdin applies to plain (.ts) scripts only');
  });

  it('reports the status the operating system would for an out-of-range numeric return', async () => {
    const run = await runScript('checksum', ['--return=300']);

    expect(run.exitCode).toBe(44);
    expect(run.stderr).toBe('');
  });

  it('exits 1 with the setter\'s own error when main returns a non-integer, as the envelope does', async () => {
    const run = await runScript('checksum', ['--return=1.5']);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('RangeError');
    expect(run.stderr).toContain('"code"');
  });
});
