/**
 * `agent-bundle/web-host` (#564): the browser host a generated bin carries as
 * its framework-owned `web` command — the command itself, the manifest `web`
 * section it reads, the token header its page presents, and the ready line
 * it shares with `agent-bundle serve-app`.
 *
 * Plain Node plus the MCP SDK client. `agent-bundle build` bundles this entry
 * into every generated bin whose plugin exposes an App, so nothing reachable
 * from here imports Effect or the compiler (`build/**`, `config/**`,
 * `services/mcp-run.ts`): the bin stays a self-contained executable (AB6005)
 * and never carries the compiler (AB4837).
 */
export {
  formatServeAppReadyLine,
  parseServeAppReadyLine,
  type ServeAppReadyLine,
} from './serve-app/command-contract.ts';
export { runWebCommand, type WebCommandOptions } from './web-host/command.ts';
export { parseWebManifest, readWebManifest, type WebManifest, type WebManifestApp } from './web-host/manifest.ts';
export { WEB_HOST_TOKEN_HEADER } from './web-host/page.ts';
