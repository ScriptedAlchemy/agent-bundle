import { noTerminal, type AgentTerminal, type AgentTerminalStream } from '../terminal-capability.ts';
import type { RenderableRouteKind } from './types.ts';

/**
 * The terminal capability (#511) an in-process harness level mounts. Nothing
 * here probes the test runner's own streams: the values are synthetic and
 * deterministic so a route test asserting on `request.terminal` reads the
 * same answer under every runner and CI. `tty` selects the interactive
 * shape the `tty` knob of `invokeCli` / `runScript` already stands for; the
 * default is the piped shape a generated executable sees under `execFile`.
 * A test that wants other values injects `context.terminal` through the
 * same seam as every identity axis.
 */
export const harnessTerminal = (hostSurface: 'cli' | 'script', tty: boolean): AgentTerminal => {
  const stream: AgentTerminalStream = tty
    ? Object.freeze({ color: 'basic', columns: 80, kind: 'tty', rows: 24 })
    : Object.freeze({ color: 'none', kind: 'pipe' });
  return Object.freeze({ hostSurface, sharesTarget: tty, stderr: stream, stdout: stream });
};

/**
 * What the artifact's request scope for one route kind mounts when no CLI
 * shell is involved: MCP tools, resources, and prompts have no terminal, an
 * event route has none, and a CLI command or script rendered directly through
 * `renderRoute` reads the harness's piped shape.
 */
export const routeKindTerminal = (kind: RenderableRouteKind): AgentTerminal => {
  switch (kind) {
    case 'prompt':
    case 'resource':
    case 'tool':
      return noTerminal('mcp');
    case 'event-route':
      return noTerminal('hook');
    case 'cli':
    case 'script':
      return harnessTerminal(kind, false);
    default: {
      const unreachable: never = kind;
      throw new TypeError(`Unsupported route kind ${String(unreachable)}.`);
    }
  }
};
