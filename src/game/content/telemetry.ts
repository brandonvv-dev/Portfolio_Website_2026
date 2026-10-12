/**
 * Reports what a visitor does in the game to the first-party beacon (window.track, which is absent
 * when the visitor opted out). It only listens: no frame hook, nothing allocated while driving.
 */
import type { GameContext, GameModule } from '../types';

/** Seconds in the air that make a landing worth reporting. */
const JUMP = 0.5;
/** Milliseconds between looks at the two saved fields, which have no event of their own. */
const WATCH = 1000;
/** The awards module prefixes its toast ids with this. */
const AWARD = 'award:';

const send = (name: string, data?: Record<string, string | number>): void => window.track?.(name, data);

export default function createTelemetry(ctx: GameContext): GameModule {
  const { events, input, props, state, store } = ctx;

  /** performance.now() at Start; negative until then. */
  let startedAt = -1;
  events.on('start', () => {
    startedAt = performance.now();
    send('game_start');
  });

  const seen = new Set<string>();
  events.on('pad', (pad) => {
    if (!pad || seen.has(pad.id)) return;
    seen.add(pad.id);
    send('game_pad', { id: pad.id });
  });

  const open = (): void => {
    const pad = state.pad;
    if (pad?.open) send('game_open', { id: pad.id });
  };
  // E reaches panels' open() through input.onInteract, which is wrapped here so it still runs. The
  // touch Open button calls open() directly and never passes through it.
  const original = input.onInteract;
  input.onInteract = () => {
    original();
    open();
  };
  document.querySelector('[data-open]')?.addEventListener('click', open);

  events.on('toast', (id) => {
    if (id.startsWith(AWARD)) send('game_award', { id: id.slice(AWARD.length) });
  });

  events.on('land', (airTime) => {
    if (airTime > JUMP) send('game_land');
  });

  let secrets = store.saved.secrets.length;
  let lap = store.saved.lapMs;
  const watch = (): void => {
    const found = store.saved.secrets;
    for (let i = secrets; i < found.length; i++) send('game_secret', { id: found[i] });
    secrets = found.length;
    if (store.saved.lapMs === lap) return;
    lap = store.saved.lapMs;
    if (lap) send('game_lap', { ms: lap });
  };
  setInterval(watch, WATCH);

  // Once per page load, at the first moment the page is hidden: on phones pagehide often never
  // fires for a tab that was only switched away from. Capture phase: at the document it runs
  // before the beacon's own visibilitychange listener, so the event joins that final flush. On
  // pagehide the beacon flushes first and the event leaves with the next flush instead.
  let left = false;
  const leave = (): void => {
    if (left || startedAt < 0) return;
    left = true;
    watch();
    send('game_leave', {
      knocked: props.knocked,
      secs: Math.round((performance.now() - startedAt) / 1000),
    });
  };
  addEventListener('pagehide', leave);
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) leave();
    },
    { capture: true },
  );

  return {};
}
