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

const EFFECT_MODULES = new Set(['effect']);
const EFFECT_NAMESPACES = new Set(['Effect', 'Runtime']);
const EFFECT_NAMESPACE_MODULES = new Set(['effect', 'effect/Effect', 'effect/Runtime']);

const posixPath = (filename: string): string => filename.replaceAll('\\', '/');

export const isEffectBoundaryFile = (filename: string): boolean =>
  posixPath(filename).endsWith('/src/effect/boundary.ts');

const importedName = (node: {
  readonly imported?: { readonly name?: string; readonly type?: string };
}): string | undefined => {
  const imported = node.imported;
  if (imported === undefined) return undefined;
  return imported.name;
};

const localName = (node: { readonly local?: { readonly name?: string } }): string | undefined =>
  node.local?.name;

const moduleName = (node: { readonly source?: { readonly value?: unknown } }): string | undefined =>
  typeof node.source?.value === 'string' ? node.source.value : undefined;

const isEffectModule = (source: string | undefined): boolean =>
  source !== undefined && (EFFECT_MODULES.has(source) || source.startsWith('effect/'));

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
            if (source === undefined || !EFFECT_NAMESPACE_MODULES.has(source)) return;
            rememberNamespace(localName(node));
          },
          MemberExpression(node: {
            readonly computed?: boolean;
            readonly object?: { readonly name?: string; readonly type?: string };
            readonly property?: { readonly name?: string; readonly type?: string };
          }) {
            if (node.computed === true) return;
            const name = node.property?.name;
            if (name === undefined || !RUN_NAMES.has(name)) return;
            const objectName = node.object?.name;
            if (objectName === undefined || !runnerNamespaces.has(objectName)) return;
            context.report({ data: { name: `${objectName}.${name}` }, messageId: 'forbiddenCall', node });
          },
        };
      },
    },
  },
};
