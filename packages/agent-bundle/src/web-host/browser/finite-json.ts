export interface FiniteOrdinaryJsonLimits {
  readonly maximumBytes?: number;
  readonly maximumDepth?: number;
  readonly maximumNodes?: number;
}

const defaultMaximumDepth = 32;
const defaultMaximumNodes = 4_096;

/**
 * Admits finite, data-only JSON while bounding traversal of untrusted browser messages.
 */
export const finiteOrdinaryJsonByteLength = (
  value: unknown,
  limits: FiniteOrdinaryJsonLimits = {},
): number | undefined => {
  const maximumDepth = limits.maximumDepth ?? defaultMaximumDepth;
  const maximumNodes = limits.maximumNodes ?? defaultMaximumNodes;
  if (
    !Number.isSafeInteger(maximumDepth) || maximumDepth < 0 ||
    !Number.isSafeInteger(maximumNodes) || maximumNodes < 1 ||
    (limits.maximumBytes !== undefined && (!Number.isSafeInteger(limits.maximumBytes) || limits.maximumBytes < 0))
  ) return undefined;

  type Visit =
    | Readonly<{ readonly kind: 'enter'; readonly value: unknown; readonly depth: number }>
    | Readonly<{ readonly kind: 'leave'; readonly value: object }>;
  const ancestors = new WeakSet<object>();
  const stack: Visit[] = [Object.freeze({ depth: 0, kind: 'enter', value })];
  let nodes = 0;
  try {
    while (stack.length > 0) {
      const visit = stack.pop();
      if (visit === undefined) continue;
      if (visit.kind === 'leave') {
        ancestors.delete(visit.value);
        continue;
      }

      nodes += 1;
      if (nodes > maximumNodes) return undefined;
      const candidate = visit.value;
      if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') continue;
      if (typeof candidate === 'number') {
        if (!Number.isFinite(candidate)) return undefined;
        continue;
      }
      if (typeof candidate !== 'object' || visit.depth > maximumDepth || ancestors.has(candidate)) return undefined;
      ancestors.add(candidate);
      stack.push(Object.freeze({ kind: 'leave', value: candidate }));

      if (Array.isArray(candidate)) {
        if (candidate.length > maximumNodes) return undefined;
        const ownKeys = Reflect.ownKeys(candidate);
        if (ownKeys.length !== candidate.length + 1 || !ownKeys.includes('length')) return undefined;
        for (let index = candidate.length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return undefined;
          stack.push(Object.freeze({ depth: visit.depth + 1, kind: 'enter', value: descriptor.value }));
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const keys = Reflect.ownKeys(candidate);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (typeof key !== 'string') return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return undefined;
        stack.push(Object.freeze({ depth: visit.depth + 1, kind: 'enter', value: descriptor.value }));
      }
    }

    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') return undefined;
    const bytes = new TextEncoder().encode(encoded).byteLength;
    return limits.maximumBytes === undefined || bytes <= limits.maximumBytes ? bytes : undefined;
  } catch {
    return undefined;
  }
};
