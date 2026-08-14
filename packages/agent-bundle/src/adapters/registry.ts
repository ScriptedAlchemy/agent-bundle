import type { NormalizationTargetRegistry } from '../core/types.ts';
import { portableAdapter } from './portable.ts';
import type { TargetAdapter } from './types.ts';

export class TargetRegistry implements NormalizationTargetRegistry {
  readonly #adapters = new Map<string, TargetAdapter>();
  readonly #defaults: string[] = [];

  register(adapter: TargetAdapter, options: { readonly default?: boolean } = {}): this {
    if (this.#adapters.has(adapter.name)) {
      throw new Error(`Target adapter "${adapter.name}" is already registered.`);
    }

    this.#adapters.set(adapter.name, adapter);
    if (options.default === true) {
      this.#defaults.push(adapter.name);
    }

    return this;
  }

  get(name: string): TargetAdapter {
    const adapter = this.#adapters.get(name);
    if (adapter === undefined) {
      throw new Error(`Unknown target adapter "${name}".`);
    }

    return adapter;
  }

  has(name: string): boolean {
    return this.#adapters.has(name);
  }

  names(): readonly string[] {
    return Object.freeze([...this.#adapters.keys()]);
  }

  defaultTargetNames(): readonly string[] {
    return Object.freeze([...this.#defaults]);
  }
}

export const createDefaultRegistry = (): TargetRegistry =>
  new TargetRegistry().register(portableAdapter, { default: true });
