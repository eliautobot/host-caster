// Tiny typed event emitter used by the core singletons (player, radio, native ...).

type Handler<T> = (payload: T) => void;

export interface Emitter<Events> {
  on<E extends keyof Events>(event: E, cb: Handler<Events[E]>): () => void;
  off<E extends keyof Events>(event: E, cb: Handler<Events[E]>): void;
  emit<E extends keyof Events>(event: E, payload: Events[E]): void;
}

export function createEmitter<Events>(): Emitter<Events> {
  const handlers = new Map<keyof Events, Set<Handler<never>>>();
  return {
    on(event, cb) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(cb as Handler<never>);
      return () => this.off(event, cb);
    },
    off(event, cb) {
      handlers.get(event)?.delete(cb as Handler<never>);
    },
    emit(event, payload) {
      for (const cb of handlers.get(event) ?? []) {
        try {
          (cb as Handler<typeof payload>)(payload);
        } catch (err) {
          console.error(`[hostcaster] ${String(event)} handler failed`, err);
        }
      }
    },
  };
}
