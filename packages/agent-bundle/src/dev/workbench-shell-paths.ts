/**
 * The Workbench's top-level URL areas (#600 §10). The foreground server answers
 * these paths with the Workbench shell (`index.html`) so a deep link such as
 * `/routes/mcp/curator/tool/search_audible` or `/trace/<id>` survives a
 * refresh; the browser's `shell/workbench-location.ts` parses the rest of the
 * path. Both sides import this one list so neither can drift.
 */
export const workbenchShellAreas = Object.freeze(['routes', 'trace', 'problems', 'sessions', 'advanced'] as const);

export type WorkbenchShellArea = (typeof workbenchShellAreas)[number];

/** True when the request path is the shell root or begins with a shell area segment. */
export const isWorkbenchShellPath = (pathname: string): boolean => {
  const [area] = pathname.split('/').filter((part) => part.length > 0);
  return area === undefined || (workbenchShellAreas as readonly string[]).includes(area);
};
