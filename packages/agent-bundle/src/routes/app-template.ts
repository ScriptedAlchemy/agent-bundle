import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * How one App route's `config.template` path resolved. `route-relative` is
 * the documented form (the path resolves from the route module like its
 * imports do); `project-relative` is the legacy form, accepted only while it
 * is the sole interpretation that names an existing file.
 */
export type AppRouteTemplateResolution =
  | {
    readonly form: 'project-relative' | 'route-relative';
    readonly kind: 'resolved';
    /** Absolute template path. */
    readonly path: string;
  }
  | {
    /** Both interpretations name different existing files. */
    readonly kind: 'ambiguous';
    readonly projectRelative: string;
    readonly routeRelative: string;
  }
  | {
    /** Neither interpretation names an existing file. */
    readonly kind: 'missing';
    readonly projectRelative: string;
    readonly routeRelative: string;
  };

const isFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Resolves an App route's `config.template` against both candidate bases.
 * An absolute template, or a relative one whose two interpretations coincide,
 * has one candidate, which still has to exist; otherwise exactly one existing
 * candidate wins, and the ambiguous and missing outcomes are reported for the
 * compiler to diagnose (AB4827).
 */
export const resolveAppRouteTemplate = (
  projectRoot: string,
  routeSource: string,
  template: string,
): AppRouteTemplateResolution => {
  const routeRelative = resolve(dirname(routeSource), template);
  const projectRelative = resolve(projectRoot, template);
  const routeExists = isFile(routeRelative);
  if (routeRelative === projectRelative) {
    return routeExists
      ? { form: 'route-relative', kind: 'resolved', path: routeRelative }
      : { kind: 'missing', projectRelative, routeRelative };
  }
  const projectExists = isFile(projectRelative);
  if (routeExists && projectExists) return { kind: 'ambiguous', projectRelative, routeRelative };
  if (routeExists) return { form: 'route-relative', kind: 'resolved', path: routeRelative };
  if (projectExists) return { form: 'project-relative', kind: 'resolved', path: projectRelative };
  return { kind: 'missing', projectRelative, routeRelative };
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
    case 'ambiguous':
    case 'missing':
      return resolution.routeRelative;
    default: {
      const unreachable: never = resolution;
      throw new TypeError(`Unhandled template resolution ${String(unreachable)}.`);
    }
  }
};
