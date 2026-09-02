/**
 * rslint community plugin: ad-hoc Effect runners are a review-fail outside
 * each package's `src/effect/boundary.ts`. See `docs/effect-conventions.md`.
 */

const RUN_NAMES = new Set([
  'runCallback',
  'runCallbackWith',
  'runFork',
  'runForkWith',
  'runPromise',
  'runPromiseExit',
  'runPromiseExitWith',
  'runPromiseWith',
  'runSync',
  'runSyncExit',
  'runSyncExitWith',
  'runSyncWith',
]);

const EFFECT_NAMESPACES = new Set(['Effect', 'Runtime']);
const EFFECT_RUNNER_NAMESPACE_MODULES = new Set(['effect/Effect', 'effect/Runtime']);

const posixPath = (filename: string): string => filename.replaceAll('\\', '/');

export const isEffectBoundaryFile = (filename: string): boolean =>
  posixPath(filename).endsWith('/src/effect/boundary.ts');

const importedName = (node: { readonly imported?: { readonly name?: string } }): string | undefined =>
  node.imported?.name;

const localName = (node: { readonly local?: { readonly name?: string } }): string | undefined =>
  node.local?.name;

const moduleName = (node: { readonly source?: { readonly value?: unknown } }): string | undefined =>
  typeof node.source?.value === 'string' ? node.source.value : undefined;

const isEffectModule = (source: string | undefined): boolean =>
  source !== undefined && (source === 'effect' || source.startsWith('effect/'));

type MemberObject = {
  readonly computed?: boolean;
  readonly name?: string;
  readonly object?: MemberObject;
  readonly property?: { readonly name?: string };
  readonly type?: string;
};

const staticMemberPath = (node: MemberObject | undefined): readonly string[] | undefined => {
  if (node?.type === 'Identifier') return node.name === undefined ? undefined : [node.name];
  if (node?.type !== 'MemberExpression' || node.computed === true) return undefined;
  const objectPath = staticMemberPath(node.object);
  const propertyName = node.property?.name;
  return objectPath === undefined || propertyName === undefined ? undefined : [...objectPath, propertyName];
};

export const effectBoundaryPlugin = {
  meta: {
    name: 'effect-boundary',
  },
  rules: {
    'no-ad-hoc-run': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Ban Effect.runPromise/runSync (and siblings) outside src/effect/boundary.ts',
        },
        messages: {
          forbiddenCall:
            'Ad-hoc {{name}} is a review-fail. Route Promise/sync edges through src/effect/boundary.ts.',
          forbiddenImport:
            'Do not import {{name}} from "effect". Route Promise/sync edges through src/effect/boundary.ts.',
        },
        schema: [],
      },
      create(context: {
        readonly filename: string;
        report(descriptor: { readonly node: unknown; readonly messageId: string; readonly data: { readonly name: string } }): void;
      }) {
        if (isEffectBoundaryFile(context.filename)) return {};
        const runnerNamespaces = new Set<string>(EFFECT_NAMESPACES);
        const effectModuleNamespaces = new Set<string>();
        const rememberNamespace = (name: string | undefined): void => {
          if (name !== undefined) runnerNamespaces.add(name);
        };
        return {
          ImportSpecifier(node: {
            readonly imported?: { readonly name?: string };
            readonly local?: { readonly name?: string };
            readonly parent?: { readonly source?: { readonly value?: unknown } };
          }) {
            const name = importedName(node);
            const source = moduleName(node.parent ?? {});
            if (!isEffectModule(source) || name === undefined) return;
            if (EFFECT_NAMESPACES.has(name)) rememberNamespace(localName(node) ?? name);
            if (!RUN_NAMES.has(name)) return;
            context.report({ data: { name }, messageId: 'forbiddenImport', node });
          },
          ImportNamespaceSpecifier(node: {
            readonly local?: { readonly name?: string };
            readonly parent?: { readonly source?: { readonly value?: unknown } };
          }) {
            const source = moduleName(node.parent ?? {});
            const name = localName(node);
            if (source === 'effect') {
              if (name !== undefined) effectModuleNamespaces.add(name);
              return;
            }
            if (source !== undefined && EFFECT_RUNNER_NAMESPACE_MODULES.has(source)) rememberNamespace(name);
          },
          MemberExpression(node: {
            readonly computed?: boolean;
            readonly object?: MemberObject;
            readonly property?: { readonly name?: string; readonly type?: string };
          }) {
            if (node.computed === true) return;
            const name = node.property?.name;
            if (name === undefined || !RUN_NAMES.has(name)) return;
            const objectPath = staticMemberPath(node.object);
            if (objectPath === undefined) return;
            const isDirectRunner = objectPath.length === 1 && runnerNamespaces.has(objectPath[0]!);
            const isNestedRunner = objectPath.length === 2
              && effectModuleNamespaces.has(objectPath[0]!)
              && EFFECT_NAMESPACES.has(objectPath[1]!);
            if (!isDirectRunner && !isNestedRunner) return;
            context.report({ data: { name: [...objectPath, name].join('.') }, messageId: 'forbiddenCall', node });
          },
        };
      },
    },
  },
};
