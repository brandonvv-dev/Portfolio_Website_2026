import type { GameContext, GameModule } from '../types';

/**
 * Axis-aligned gates across the client street, in the order they are driven. The street always
 * runs up the screen, so each gate has one direction: 'z' gates are crossed towards -z, 'x'
 * gates towards -x. Checkpoints stand 10 m past the three corners (104, 0), the hub and (0, -104).
 */
interface Gate {
  /** The axis the gate stands on: its plane is axis = at. */
  axis: 'x' | 'z';
  at: number;
  /** Extent along the other axis. */
  lo: number;
  hi: number;
}

const GATES: readonly Gate[] = [
  { axis: 'z', at: 90, lo: 98, hi: 110 },
  { axis: 'x', at: 94, lo: -6, hi: 6 },
  { axis: 'z', at: -10, lo: -6, hi: 6 },
  { axis: 'x', at: -10, lo: -110, hi: -98 },
  { axis: 'x', at: -90, lo: -110, hi: -98 },
];
const LAST = GATES.length - 1;
/** A run with no gate for this long is abandoned. */
const PATIENCE = 30;

/** Index of the gate the step (px, pz) to (x, z) crosses in its direction, or -1. */
function crossed(px: number, pz: number, x: number, z: number): number {
  for (let i = 0; i <= LAST; i++) {
    const g = GATES[i];
    const before = g.axis === 'z' ? pz : px;
    const after = g.axis === 'z' ? z : x;
    if (before <= g.at || after > g.at) continue;
    // Where along the gate the step passed it.
    const f = (before - g.at) / (before - after);
    const other = g.axis === 'z' ? px + (x - px) * f : pz + (z - pz) * f;
    if (other >= g.lo && other <= g.hi) return i;
  }
  return -1;
}

export default function createTrial(ctx: GameContext): GameModule {
  const hud = document.querySelector('[data-hud]');
  if (!hud) return {};

  const chip = document.createElement('div');
  chip.className = 'hud-stat';
  chip.hidden = true;
  const value = document.createElement('b');
  const unit = document.createElement('span');
  unit.textContent = 's';
  chip.append(value, unit);
  hud.append(chip);

  const { car, events, store } = ctx;
  let next = -1; // the gate that must be passed next; -1 when no run is active
  let elapsed = 0;
  let sinceGate = 0;
  let shown = '';
  let known = false;
  let px = 0;
  let pz = 0;

  const drop = (): void => {
    next = -1;
    chip.hidden = true;
  };
  // The car was moved: its next position is not a drive from the old one.
  // The debug hook's place() has no name and is how the monitor drives a run gate to gate.
  events.on('respawn', (at) => {
    known = false;
    if (at.name !== '') drop();
  });

  return {
    update(dt) {
      const x = car.position.x;
      const z = car.position.z;
      if (!known) {
        px = x;
        pz = z;
        known = true;
      }
      if (next >= 0) {
        elapsed += dt;
        sinceGate += dt;
        if (sinceGate > PATIENCE) drop();
      }
      const gate = crossed(px, pz, x, z);
      px = x;
      pz = z;
      if (gate === 0) {
        next = 1;
        elapsed = 0;
        sinceGate = 0;
        chip.hidden = false;
      } else if (gate > 0 && next >= 0) {
        if (gate !== next) drop();
        else if (gate < LAST) {
          next++;
          sinceGate = 0;
        } else {
          const ms = Math.round(elapsed * 1000);
          const better = store.saved.lapMs === 0 || ms < store.saved.lapMs;
          if (better) {
            store.saved.lapMs = ms;
            store.save();
          }
          drop();
          events.emit('toast', 'lap', 'Handover Run', `${(ms / 1000).toFixed(1)} s${better ? ' - new best' : ''}`);
          events.emit('sound', 'award');
        }
      }
      if (next >= 0) {
        const text = elapsed.toFixed(1);
        if (text !== shown) {
          shown = text;
          value.textContent = text;
        }
      }
    },
  };
}
