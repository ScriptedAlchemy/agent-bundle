export interface McpArtifactPathApi {
  readonly isAbsolute: (path: string) => boolean;
  readonly normalize: (path: string) => string;
  readonly relative: (from: string, to: string) => string;
  readonly resolve: (...paths: string[]) => string;
  readonly sep: '/' | '\\';
}

export interface McpArtifactReferenceRoots {
  readonly artifactRoot: string;
  readonly targetRoot: string;
}

export interface McpArtifactLocalReference {
  readonly path: string;
  readonly status: 'artifact-local';
}

export interface McpArtifactEscapedReference {
  readonly status: 'escaped';
}

export interface McpArtifactExternalReference {
  readonly status: 'external';
}

export type McpArtifactReference =
  | McpArtifactLocalReference
  | McpArtifactEscapedReference
  | McpArtifactExternalReference;

const driveAbsolutePath = /^[a-z]:[\\/]/iu;
const driveRelativePath = /^[a-z]:(?![\\/])/iu;
const uncPath = /^(?:\\\\|\/\/)/u;
const scheme = /^([a-z][a-z\d+.-]*):/iu;
const externalNetworkSchemes = new Set(['http', 'https']);

const argumentValue = (value: string): string => {
  const assignment = value.startsWith('-') ? value.indexOf('=') : -1;
  return assignment < 0 ? value : value.slice(assignment + 1);
};

const isWindowsPathApi = (path: McpArtifactPathApi): boolean => path.sep === '\\';

const isWindowsAbsolutePath = (value: string): boolean => driveAbsolutePath.test(value) || uncPath.test(value);

const localPathFor = (value: string, path: McpArtifactPathApi): string =>
  path.sep === '/'
    ? value.replaceAll('\\', '/')
    : value.replaceAll('/', '\\');

const pathWithin = (path: McpArtifactPathApi, root: string, candidate: string): string | undefined => {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? undefined
    : relative.replaceAll(path.sep, '/');
};

const fileUrlPath = (value: string, path: McpArtifactPathApi): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'file:') return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const hostname = url.hostname === 'localhost' ? '' : url.hostname;
  if (isWindowsPathApi(path)) {
    const local = pathname.startsWith('/') && driveAbsolutePath.test(pathname.slice(1))
      ? pathname.slice(1)
      : pathname;
    return hostname.length === 0
      ? local.replaceAll('/', '\\')
      : `\\\\${hostname}${local.replaceAll('/', '\\')}`;
  }
  return hostname.length === 0 ? pathname : `//${hostname}${pathname}`;
};

const isCanonicalRelativePath = (value: string, path: McpArtifactPathApi): boolean => {
  const relative = value.startsWith(`.${path.sep}`) ? value.slice(2) : value;
  return relative.length > 0 &&
    relative === path.normalize(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`);
};

const classifyAbsolutePath = (options: {
  readonly rejectOutsideTarget?: boolean;
  readonly path: McpArtifactPathApi;
  readonly roots: McpArtifactReferenceRoots;
  readonly value: string;
}): McpArtifactReference => {
  const resolved = options.path.resolve(options.value);
  const targetPath = pathWithin(options.path, options.roots.targetRoot, resolved);
  if (targetPath !== undefined && options.path.normalize(options.value) === resolved) {
    return { path: targetPath, status: 'artifact-local' };
  }
  if (isWindowsPathApi(options.path)) return { status: 'escaped' };
  const artifactPath = pathWithin(options.path, options.roots.artifactRoot, resolved);
  return artifactPath === undefined && options.rejectOutsideTarget !== true
    ? { status: 'external' }
    : { status: 'escaped' };
};

/**
 * Classifies a resolved stdio argument without touching the filesystem. The caller
 * injects its path semantics so artifact validation can model POSIX and Windows
 * independently of the host on which it runs.
 */
export const classifyMcpArtifactArgument = (options: {
  readonly path: McpArtifactPathApi;
  readonly roots: McpArtifactReferenceRoots;
  readonly value: string;
}): McpArtifactReference => {
  const value = argumentValue(options.value);
  if (driveRelativePath.test(value)) return { status: 'escaped' };
  if (isWindowsAbsolutePath(value)) {
    return isWindowsPathApi(options.path)
      ? classifyAbsolutePath({ ...options, value: localPathFor(value, options.path) })
      : { status: 'escaped' };
  }

  const schemeMatch = scheme.exec(value);
  if (schemeMatch !== null) {
    if (schemeMatch[1]!.toLowerCase() === 'file') {
      const filePath = fileUrlPath(value, options.path);
      return filePath === undefined
        ? { status: 'escaped' }
        : classifyAbsolutePath({ ...options, rejectOutsideTarget: true, value: filePath });
    }
    return externalNetworkSchemes.has(schemeMatch[1]!.toLowerCase())
      ? { status: 'external' }
      : { status: 'escaped' };
  }

  const localPath = localPathFor(value, options.path);
  if (options.path.isAbsolute(localPath)) return classifyAbsolutePath({ ...options, value: localPath });
  if (!localPath.startsWith('.') && !localPath.includes(options.path.sep)) return { status: 'external' };
  if (!isCanonicalRelativePath(localPath, options.path)) return { status: 'escaped' };
  const targetPath = pathWithin(options.path, options.roots.targetRoot, options.path.resolve(options.roots.targetRoot, localPath));
  return targetPath === undefined
    ? { status: 'escaped' }
    : { path: targetPath, status: 'artifact-local' };
};
