import { Agent, agent } from '@agent-bundle/runtime';
import type { ScriptRouteProps } from 'agent-bundle';

// Evaluation is observable: harness tests prove the module is not loaded for
// a run the shell rejected, nor once a run has reported its cancellation.
const tally = globalThis as { routeHarnessSummaryLoads?: number };
tally.routeHarnessSummaryLoads = (tally.routeHarnessSummaryLoads ?? 0) + 1;

/**
 * A rendered script: `argv` is whatever remained after the framework reserved
 * `--json` / `--ndjson`. `--fail` renders a represented error document, and
 * `--explode` throws, so the harness can prove both exit paths.
 */
export default async function Summary({ argv, signal }: ScriptRouteProps) {
  const context = await agent();
  await context.progress.report({ completed: 1, message: 'collecting arguments', total: 2 });
  if (argv.includes('--explode')) {
    throw new Error('summary render exploded');
  }
  if (argv.includes('--log')) {
    // Diagnostic output from a rendered script: the generated executable
    // forwards the render worker's stdout and stderr onto its own stderr, so
    // machine output on stdout stays clean.
    console.log('summary log line');
    process.stdout.write('summary stdout line\n');
    process.stderr.write('summary stderr line\n');
  }
  if (argv.includes('--wait-for-abort')) {
    await new Promise<void>((_resolve, reject) => {
      const rejectAborted = () => reject(new DOMException('Summary render aborted', 'AbortError'));
      if (signal.aborted) {
        rejectAborted();
        return;
      }
      signal.addEventListener('abort', rejectAborted, { once: true });
    });
  }
  const exitFlag = argv.find((argument) => argument.startsWith('--exit='));
  if (exitFlag !== undefined) {
    // `process.exit` from rendered code: in the generated executable this ends
    // the render worker, and the shell reports the exit. `--catch-exit` swallows
    // the call and carries on, as careless code might.
    const code = Number(exitFlag.slice('--exit='.length));
    if (argv.includes('--catch-exit')) {
      try {
        process.exit(code);
      } catch {
        console.log('summary carried on after process.exit');
      }
    } else {
      process.exit(code);
    }
  }
  await context.progress.report({ completed: 2, message: 'summary ready', total: 2 });
  const value = {
    arguments: [...argv],
    invocation: context.invocation.kind,
    stateMounted: context.state !== undefined,
    surface: context.invocation.surface ?? null,
    // The executable's probed terminal (#511), as `<surface>/<stdout kind>/<stderr kind>`.
    terminal: context.terminal.state === 'available'
      ? `${context.terminal.value.hostSurface}/${context.terminal.value.stdout.kind}/${context.terminal.value.stderr.kind}`
      : `unavailable:${context.terminal.reason}`,
  };
  if (argv.includes('--fail')) {
    return (
      <Agent.Result value={value}>
        <Agent.Error code="summary.failed">The summary was asked to fail.</Agent.Error>
      </Agent.Result>
    );
  }
  return (
    <Agent.Result value={value}>
      <Agent.Markdown>{`# Summary\n\n${String(argv.length)} argument(s).`}</Agent.Markdown>
      <Agent.Text>{`surface: ${String(context.invocation.surface)}`}</Agent.Text>
    </Agent.Result>
  );
}
