/** Plain Node entry bundled into generated executables; do not add Effect or compiler imports (#564). */
export {
  formatServeAppReadyLine,
  parseServeAppReadyLine,
  type ServeAppReadyLine,
} from './serve-app/command-contract.ts';
export { runWebCommand, type WebCommandOptions } from './web-host/command.ts';
export { parseWebManifest, readWebManifest, type WebManifest, type WebManifestApp } from './web-host/manifest.ts';
export { WEB_HOST_TOKEN_HEADER } from './web-host/page.ts';
