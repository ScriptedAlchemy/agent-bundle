import type {
  NormalizationConfigExtension,
  NormalizationTargetRegistry,
} from '../core/types.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { portableAdapter } from './portable.ts';
import type { TargetAdapter } from './types.ts';

export class TargetRegistry implements NormalizationTargetRegistry {
  readonly #adapters = new Map<string, TargetAdapter>();
  readonly #defaults: string[] = [];
  readonly #extensions = new Map<string, NormalizationConfigExtension>();

  register(adapter: TargetAdapter, options: { readonly default?: boolean } = {}): this {
    if (this.#adapters.has(adapter.name)) {
      throw new Error(`Target adapter "${adapter.name}" is already registered.`);
    }
    const extension = adapter.configExtension;
    if (extension !== undefined && this.#extensions.has(extension.key)) {
      throw new Error(`Config extension key "${extension.key}" is already registered.`);
    }

    this.#adapters.set(adapter.name, adapter);
    if (extension !== undefined) {
      this.#extensions.set(extension.key, Object.freeze({
        key: extension.key,
        target: adapter.name,
      }));
    }
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

  configExtensions(): readonly NormalizationConfigExtension[] {
    return Object.freeze([...this.#extensions.values()]);
  }

  supports(name: string, capability: string): boolean {
    return this.#adapters.get(name)?.capabilities[capability] === true;
  }

  names(): readonly string[] {
    return Object.freeze([...this.#adapters.keys()]);
  }

  defaultTargetNames(): readonly string[] {
    return Object.freeze([...this.#defaults]);
  }
}

export const createDefaultRegistry = (): TargetRegistry =>
  new TargetRegistry()
    .register(portableAdapter, { default: true })
    .register(codexAdapter)
    .register(claudeAdapter);
