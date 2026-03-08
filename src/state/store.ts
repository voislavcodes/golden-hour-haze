type Listener<T> = (value: T) => void;
type Selector<T, R> = (state: T) => R;

export interface Store<T> {
  get(): T;
  set(partial: Partial<T>): void;
  update(fn: (state: T) => Partial<T>): void;
  subscribe(listener: Listener<T>): () => void;
  select<R>(selector: Selector<T, R>, listener: Listener<R>): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = { ...initial };
  let listeners = new Set<Listener<T>>();
  let selectorListeners = new Map<Listener<unknown>, { selector: Selector<T, unknown>; prev: unknown }>();
  let pendingNotify = false;

  function notify() {
    if (pendingNotify) return;
    pendingNotify = true;
    queueMicrotask(() => {
      pendingNotify = false;
      for (const l of listeners) l(state);
      for (const [listener, info] of selectorListeners) {
        const next = info.selector(state);
        if (next !== info.prev) {
          info.prev = next;
          listener(next);
        }
      }
    });
  }

  return {
    get() { return state; },

    set(partial: Partial<T>) {
      state = { ...state, ...partial };
      notify();
    },

    update(fn: (state: T) => Partial<T>) {
      state = { ...state, ...fn(state) };
      notify();
    },

    subscribe(listener: Listener<T>) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    select<R>(selector: Selector<T, R>, listener: Listener<R>) {
      const prev = selector(state);
      selectorListeners.set(listener as Listener<unknown>, { selector: selector as Selector<T, unknown>, prev });
      return () => { selectorListeners.delete(listener as Listener<unknown>); };
    },
  };
}
