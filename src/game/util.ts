/**
 * The four helpers every module shares: the event bus, the store that survives a reload, the
 * spring behind every eased value, and the seeded random stream.
 */
import type { Events, GameEvents, Saved, Store } from './types';

type Listeners = { [K in keyof GameEvents]?: ((...args: GameEvents[K]) => void)[] };

/**
 * Delivery is synchronous and in registration order, so an emit inside a click or a keydown is
 * still inside that gesture when its listeners run. Nothing is ever unsubscribed: every listener
 * belongs to a module, and modules live as long as the page.
 */
export function createEvents(): Events {
  const listeners: Listeners = {};
  // The one cast: indexing the mapped type by a generic key does not narrow to that key's list.
  const of = <K extends keyof GameEvents>(type: K) =>
    (listeners[type] ??= []) as ((...args: GameEvents[K]) => void)[];
  return {
    on(type, listener) {
      of(type).push(listener);
    },
    emit(type, ...args) {
      for (const listener of of(type)) listener(...args);
    },
  };
}

/**
 * Storage throws in private mode, in a sandboxed frame and when the quota is gone. Both sides are
 * guarded, so there the game simply remembers for as long as the page lives.
 */
export function createStore(): Store {
  let stored: Partial<Saved> = {};
  try {
    stored = JSON.parse(localStorage.getItem('drive') ?? '{}');
  } catch {
    // Nothing readable: start from the defaults.
  }
  const saved: Saved = { muted: false, chase: false, sites: [], secrets: [], lapMs: 0, ...stored };
  return {
    saved,
    save() {
      try {
        localStorage.setItem('drive', JSON.stringify(saved));
      } catch {
        // Memory only.
      }
    },
  };
}

/**
 * A critically damped spring in closed form, so it settles without ringing and the answer does
 * not depend on how the time is cut up: one 16 ms frame and four of 4 ms end in the same place.
 * A lerp by a constant factor per frame does not, and eases at a different speed on every display.
 * From rest, about 60 % of the gap closes in smoothTime and 90 % in twice that.
 */
export function springTo(
  state: { x: number; v: number },
  target: number,
  smoothTime: number,
  dt: number,
): void {
  const w = 2 / smoothTime;
  const e = state.x - target;
  const c = (state.v + w * e) * dt;
  const E = Math.exp(-w * dt);
  state.v = (state.v - w * c) * E;
  state.x = target + (e + c) * E;
}

/** Deterministic, so the world looks the same on every visit. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
