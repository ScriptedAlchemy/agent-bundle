import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** How one App route's `config.template` path resolved from its route module. */
export type AppRouteTemplateResolution =
  | {
    readonly kind: 'resolved';
    /** Absolute template path. */
    readonly path: string;
  }
  | {
    /** The route-relative interpretation names no existing file. */
    readonly kind: 'missing';
    readonly routeRelative: string;
  };

const isFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Resolves an App route's `config.template` relative to the route module. */
export const resolveAppRouteTemplate = (
  routeSource: string,
  template: string,
): AppRouteTemplateResolution => {
  const routeRelative = resolve(dirname(routeSource), template);
  return isFile(routeRelative)
    ? { kind: 'resolved', path: routeRelative }
    : { kind: 'missing', routeRelative };
};

/**
 * The template path the normalized model carries: the resolved candidate, or
 * the route-relative interpretation when resolution failed so the build still
 * fails loudly on the documented form beside the AB4827 diagnostic.
 */
export const appRouteTemplatePath = (resolution: AppRouteTemplateResolution): string => {
  switch (resolution.kind) {
    case 'resolved':
      return resolution.path;
    case 'missing':
      return resolution.routeRelative;
    default: {
      const unreachable: never = resolution;
      throw new TypeError(`Unhandled template resolution ${String(unreachable)}.`);
    }
  }
};
