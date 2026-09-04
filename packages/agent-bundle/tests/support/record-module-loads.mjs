/**
 * `node --import` preload for the CLI cold-start proofs: records every module
 * URL the process resolves (ESM and CJS, through the in-thread
 * `module.registerHooks` resolve hook) and writes the list, one URL per
 * line, to the file named by AGENT_BUNDLE_RECORD_MODULE_LOADS when the
 * process exits. `node:` builtins are skipped. Plain `.mjs` so Node loads it
 * without type stripping.
 */
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import process from 'node:process';

const recordPath = process.env['AGENT_BUNDLE_RECORD_MODULE_LOADS'];
if (typeof recordPath !== 'string' || recordPath.length === 0) {
  throw new Error('record-module-loads.mjs needs AGENT_BUNDLE_RECORD_MODULE_LOADS to name the output file.');
}

const loaded = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (!resolved.url.startsWith('node:')) loaded.push(resolved.url);
    return resolved;
  },
});

process.on('exit', () => {
  writeFileSync(recordPath, `${loaded.join('\n')}\n`);
});
