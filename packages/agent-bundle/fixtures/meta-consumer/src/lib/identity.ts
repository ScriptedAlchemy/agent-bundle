import meta, { name, packageName, packageVersion, version } from 'agent-bundle/meta';

/**
 * The pattern the framework-mode guidance recommends: no hand-written
 * `src/lib/version.ts`, the module reads identity from the framework. Every
 * binding is read at module evaluation, so importing this module outside a
 * compiled surface or an aliasing test pool is exactly the failure #386
 * reports.
 */
export const identity = Object.freeze({ name, packageName, packageVersion, version });

export const frozenMeta = meta;

export const banner = `${name} ${version}`;
