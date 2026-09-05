// Resolves a React node tree into a flat stream of host nodes:
// strings (text) and { tag, props, children } objects. Function and class
// components are invoked, promises are awaited, fragments/providers/etc.
// are unwrapped. No react-dom involved.

import * as React from 'react';

const ELEMENT_TYPES = new Set([
  Symbol.for('react.transitional.element'), // React 19
  Symbol.for('react.element'), // React <= 18
]);

const FRAGMENT = Symbol.for('react.fragment');
const STRICT_MODE = Symbol.for('react.strict_mode');
const PROFILER = Symbol.for('react.profiler');
const SUSPENSE = Symbol.for('react.suspense');
const SUSPENSE_LIST = Symbol.for('react.suspense_list');
const LAZY = Symbol.for('react.lazy');
const MEMO = Symbol.for('react.memo');
const FORWARD_REF = Symbol.for('react.forward_ref');
const CONTEXT = Symbol.for('react.context');
const PROVIDER = Symbol.for('react.provider'); // React <= 18 <Ctx.Provider>
const CONSUMER = Symbol.for('react.consumer'); // React 19 <Ctx.Consumer>
const ACTIVITY = Symbol.for('react.activity'); // React 19.2 <Activity>
const VIEW_TRANSITION = Symbol.for('react.view_transition');

// Host tags whose children are not document content: styles, scripts and
// head metadata would otherwise leak into the markdown as paragraphs.
const DROPPED_TAGS = new Set([
  'script', 'style', 'template', 'noscript', 'head', 'title', 'meta', 'link', 'base',
]);

// Which internals key exists depends on the react build: client (React 19),
// react-server (React 19, e.g. inside an RSC server module graph), or legacy
// (React <= 18). Located with computed access because a static namespace
// property access on a missing export is an ESM linking error under strict
// bundlers (rspack/webpack) when the react-server condition selects a build
// without the client export.
const internalsKey = [
  '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
  '__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
  '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
].find((key) => React[key] !== undefined && React[key] !== null);
const ReactSharedInternals = internalsKey === undefined ? null : React[internalsKey];

const isThenable = (value) =>
  value !== null && typeof value === 'object' && typeof value.then === 'function';

// Mirrors React's convention of tracking settlement on the thenable itself,
// so `use` can return synchronously on re-render.
function trackThenable(thenable) {
  if (typeof thenable.status === 'string') return thenable;
  thenable.status = 'pending';
  thenable.then(
    (value) => {
      thenable.status = 'fulfilled';
      thenable.value = value;
    },
    (reason) => {
      thenable.status = 'rejected';
      thenable.reason = reason;
    },
  );
  return thenable;
}

// Context values are kept in an immutable linked list threaded through the
// walk; `currentContext` points at the list for the component being invoked.
let currentContext = null;

function readContextValue(context, ctx) {
  for (let node = ctx; node !== null; node = node.parent) {
    if (node.context === context) return node.value;
  }
  return context._currentValue;
}

let idCounter = 0;
const noop = () => {};

const Dispatcher = {
  use(usable) {
    if (isThenable(usable)) {
      const thenable = trackThenable(usable);
      switch (thenable.status) {
        case 'fulfilled':
          return thenable.value;
        case 'rejected':
          throw thenable.reason;
        default:
          throw thenable; // suspend; the walker awaits and re-invokes
      }
    }
    if (usable !== null && typeof usable === 'object' && usable.$$typeof === CONTEXT) {
      return readContextValue(usable, currentContext);
    }
    throw new Error('Unsupported usable passed to use()');
  },
  readContext: (context) => readContextValue(context, currentContext),
  useContext: (context) => readContextValue(context, currentContext),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
  useReducer: (_reducer, initialArg, init) => [init ? init(initialArg) : initialArg, noop],
  useMemo: (create) => create(),
  useCallback: (callback) => callback,
  useRef: (initial) => ({ current: initial }),
  useEffect: noop,
  useLayoutEffect: noop,
  useInsertionEffect: noop,
  useImperativeHandle: noop,
  useDebugValue: noop,
  useId: () => ':rscmd' + (idCounter++).toString(32) + ':',
  useTransition: () => [false, noop],
  useDeferredValue: (value) => value,
  useSyncExternalStore: (_subscribe, getSnapshot, getServerSnapshot) =>
    (getServerSnapshot ?? getSnapshot)(),
  useOptimistic: (state) => [state, noop],
  useActionState: (_action, initialState) => [initialState, noop, false],
  useCacheRefresh: () => noop,
};

function installDispatcher() {
  if (ReactSharedInternals === null) return noop;
  if (ReactSharedInternals.ReactCurrentDispatcher) {
    // React <= 18
    const slot = ReactSharedInternals.ReactCurrentDispatcher;
    const prev = slot.current;
    slot.current = Dispatcher;
    return () => {
      slot.current = prev;
    };
  }
  const prev = ReactSharedInternals.H;
  ReactSharedInternals.H = Dispatcher;
  return () => {
    ReactSharedInternals.H = prev;
  };
}

// Invoke a render function with the hooks dispatcher installed. When it
// suspends (throws a thenable, e.g. via React.use), await it and re-invoke.
async function invokeComponent(render, ctx) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let thrown;
    const prevContext = currentContext;
    currentContext = ctx;
    const restore = installDispatcher();
    try {
      return render();
    } catch (error) {
      thrown = error;
    } finally {
      restore();
      currentContext = prevContext;
    }
    if (!isThenable(thrown)) throw thrown;
    await trackThenable(thrown); // rethrows the reason if it rejects
  }
  throw new Error('Component suspended too many times without resolving');
}

const isClassComponent = (type) =>
  typeof type === 'function' && !!(type.prototype && type.prototype.isReactComponent);

// Emitted around the children of "container" host tags (div, article, …)
// when they are streamed instead of buffered, so the serializer can keep
// the block boundary that the wrapper implies.
export const BLOCK_BOUNDARY = Symbol('rsc-markdown-stream.block-boundary');

// Starts consuming an async iterator eagerly, buffering its output, so that
// sibling subtrees resolve concurrently (like React) while document order
// is preserved. Errors are captured and rethrown to the reader.
function prefetch(iterator) {
  const buffer = [];
  let state = 'running';
  let error;
  let wake = null;
  (async () => {
    try {
      for await (const item of iterator) {
        buffer.push(item);
        wake?.();
      }
      state = 'done';
    } catch (err) {
      state = 'error';
      error = err;
    }
    wake?.();
  })();
  return async function* read() {
    let index = 0;
    for (;;) {
      while (index < buffer.length) yield buffer[index++];
      if (state === 'done') return;
      if (state === 'error') throw error;
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  };
}

// Async generator over the resolved host nodes of a React tree, in document
// order. Leaf block subtrees (p, pre, table, …) are resolved in full before
// being yielded; container tags and siblings stream. `config.hostMode(tag)`
// (optional) classifies host tags as 'container' | 'transparent' | 'buffer'.
export async function* resolveStream(node, ctx = null, config = null) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string') {
    if (node !== '') yield node;
    return;
  }
  if (typeof node === 'number' || typeof node === 'bigint') {
    yield String(node);
    return;
  }
  if (Array.isArray(node)) {
    if (node.length === 1) {
      yield* resolveStream(node[0], ctx, config);
    } else if (node.length > 1) {
      const readers = node.map((child) => prefetch(resolveStream(child, ctx, config)));
      for (const read of readers) yield* read();
    }
    return;
  }
  if (typeof node === 'object') {
    if (ELEMENT_TYPES.has(node.$$typeof)) {
      yield* resolveElement(node.type, node.props, ctx, config);
      return;
    }
    if (node.$$typeof === LAZY) {
      // Flight clients wrap pending server-component subtrees in lazy *nodes*
      // (not lazy element types). _init throws the chunk while pending;
      // invokeComponent awaits it and retries.
      yield* resolveStream(await invokeComponent(() => node._init(node._payload), ctx), ctx, config);
      return;
    }
    if (isThenable(node)) {
      yield* resolveStream(await node, ctx, config);
      return;
    }
    if (typeof node[Symbol.iterator] === 'function') {
      yield* resolveStream(Array.from(node), ctx, config);
      return;
    }
    if (typeof node[Symbol.asyncIterator] === 'function') {
      for await (const child of node) yield* resolveStream(child, ctx, config);
      return;
    }
  }
  throw new Error(`Unsupported React node: ${Object.prototype.toString.call(node)}`);
}

async function* resolveElement(type, props, ctx, config) {
  if (typeof type === 'string') {
    if (DROPPED_TAGS.has(type)) return;
    const mode = config?.hostMode ? config.hostMode(type) : 'buffer';
    if (mode === 'container') {
      // Pass-through block (div, article, …): stream children instead of
      // buffering the whole subtree, keeping the block boundary it implies.
      yield BLOCK_BOUNDARY;
      yield* resolveStream(props.children, ctx, config);
      yield BLOCK_BOUNDARY;
      return;
    }
    if (mode === 'transparent') {
      // Unknown/span-like tag: children flow into the surrounding content.
      yield* resolveStream(props.children, ctx, config);
      return;
    }
    yield { tag: type, props, children: await resolveNode(props.children, ctx) };
    return;
  }
  if (
    type === FRAGMENT ||
    type === STRICT_MODE ||
    type === PROFILER ||
    type === SUSPENSE ||
    type === SUSPENSE_LIST ||
    type === VIEW_TRANSITION
  ) {
    // Suspense: content is always awaited, fallbacks never render.
    yield* resolveStream(props.children, ctx, config);
    return;
  }
  if (type === ACTIVITY) {
    // Hidden activities are offscreen content; markdown has no offscreen.
    if (props.mode !== 'hidden') yield* resolveStream(props.children, ctx, config);
    return;
  }
  if (typeof type === 'function') {
    const render = isClassComponent(type)
      ? () => {
          const instance = new type(props);
          return instance.render();
        }
      : () => type(props);
    yield* resolveStream(await invokeComponent(render, ctx), ctx, config);
    return;
  }
  if (type !== null && typeof type === 'object') {
    switch (type.$$typeof) {
      case LAZY: {
        const resolvedType = await invokeComponent(() => type._init(type._payload), ctx);
        yield* resolveElement(resolvedType, props, ctx, config);
        return;
      }
      case MEMO:
        yield* resolveElement(type.type, props, ctx, config);
        return;
      case FORWARD_REF:
        yield* resolveStream(
          await invokeComponent(() => type.render(props, null), ctx),
          ctx,
          config,
        );
        return;
      case PROVIDER:
        yield* resolveStream(
          props.children,
          { context: type._context, value: props.value, parent: ctx },
          config,
        );
        return;
      case CONTEXT:
        if (typeof props.children === 'function') {
          // React <= 18 <Ctx.Consumer> renders the context object directly.
          yield* resolveStream(props.children(readContextValue(type, ctx)), ctx, config);
          return;
        }
        // React 19: the context object itself is the provider.
        yield* resolveStream(
          props.children,
          { context: type, value: props.value, parent: ctx },
          config,
        );
        return;
      case CONSUMER:
        yield* resolveStream(props.children(readContextValue(type._context, ctx)), ctx, config);
        return;
    }
  }
  throw new Error(`Unsupported element type: ${String(type)}`);
}

export async function resolveNode(node, ctx = null) {
  const out = [];
  for await (const item of resolveStream(node, ctx)) out.push(item);
  return out;
}
