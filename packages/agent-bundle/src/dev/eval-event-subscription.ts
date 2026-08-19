import type { EvalRunEvent } from '../eval/run-store.ts';
import type { EvalEventSubscription, EvalRunEventsReplay } from './eval-service-types.ts';

export class PendingEvalEventSubscription implements EvalEventSubscription {
  #closed = false;
  #listener: ((event: EvalRunEvent) => void) | undefined;
  readonly #onClose: () => void;
  #queued: EvalRunEvent[] = [];
  #replay: EvalRunEventsReplay | undefined;

  constructor(onClose: () => void) {
    this.#onClose = onClose;
  }

  get replay(): EvalRunEventsReplay {
    if (this.#replay === undefined) throw new Error('Eval event subscription has not finished replaying.');
    return this.#replay;
  }

  bind(replay: EvalRunEventsReplay): void {
    this.#replay = replay;
    this.#queued = this.#queued.filter((event) => event.sequence > replay.cursor.afterSequence);
  }

  publish(event: EvalRunEvent): void {
    if (this.#closed) return;
    if (this.#replay !== undefined && event.sequence <= this.#replay.cursor.afterSequence) return;
    const listener = this.#listener;
    if (listener === undefined) this.#queued.push(event);
    else listener(event);
  }

  activate(listener: (event: EvalRunEvent) => void): void {
    if (this.#closed || this.#listener !== undefined) return;
    this.#listener = listener;
    const queued = this.#queued;
    this.#queued = [];
    for (const event of queued) listener(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listener = undefined;
    this.#queued = [];
    this.#onClose();
  }
}
