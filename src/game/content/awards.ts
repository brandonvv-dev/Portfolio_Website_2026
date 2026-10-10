/**
 * Ten awards for things the world already lets you do. Everything is read from the event bus or
 * from state the contract exposes; nothing here touches handling, the camera or the pads.
 */
import type { GameContext, GameModule } from '../types';

const AWARDS: readonly { id: string; title: string; line: string }[] = [
  { id: 'air', title: 'Big air', line: 'Nearly a second off the ground.' },
  { id: 'flat-out', title: 'Flat out', line: 'Past 120 km/h.' },
  { id: 'reverse', title: 'Wrong way', line: 'Reversing at speed.' },
  { id: 'wreck-50', title: 'Demolition', line: '50 things knocked over.' },
  { id: 'wreck-150', title: 'Total demolition', line: '150 things knocked over.' },
  { id: 'dominoes', title: 'Chain reaction', line: 'Eighteen dominoes in eight seconds.' },
  { id: 'strike', title: 'Strike', line: 'Ten pins in one go.' },
  { id: 'handover', title: 'Handover', line: 'The timed run, finished.' },
  { id: 'whole-street', title: 'The whole street', line: 'Every client site visited.' },
  { id: 'hello', title: 'Say hello', line: 'LinkedIn, GitHub and email, all visited.' },
];
const TOAST_AWARD: Readonly<Record<string, string>> = {
  strike: 'strike',
  lap: 'handover',
  'all-sites': 'whole-street',
};
const HELLO = ['linkedin', 'github', 'email'];
const DOMINOES = 18;
const KEY = 'drive:awards';

function load(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export default function createAwards(ctx: GameContext): GameModule {
  const hud = document.querySelector('[data-hud]');
  if (!hud) return {};

  const { car, events, props, state } = ctx;
  const earned = new Set(load());

  const chip = document.createElement('div');
  chip.className = 'hud-stat';
  const count = document.createElement('b');
  const unit = document.createElement('span');
  unit.textContent = 'awards';
  chip.append(count, unit);
  hud.append(chip);

  const show = (): void => {
    count.textContent = `${earned.size}/${AWARDS.length}`;
    chip.title = `Still to earn: ${AWARDS.filter((a) => !earned.has(a.id)).map((a) => a.title).join(', ') || 'nothing'}`;
  };
  show();

  const grant = (id: string): void => {
    if (earned.has(id)) return;
    const award = AWARDS.find((a) => a.id === id);
    if (!award) return;
    earned.add(id);
    try {
      localStorage.setItem(KEY, JSON.stringify([...earned]));
    } catch {
      // Memory only.
    }
    show();
    events.emit('toast', `award:${id}`, award.title, award.line);
    events.emit('sound', 'award');
  };

  events.on('land', (airTime) => {
    if (airTime >= 0.8) grant('air');
  });
  events.on('toast', (id) => {
    const award = TOAST_AWARD[id];
    if (award) grant(award);
  });

  // The last 18 domino knocks: the oldest of them is the one that ends the window.
  const knocks = new Float64Array(DOMINOES).fill(-Infinity);
  let next = 0;
  events.on('knock', (kind) => {
    if (kind !== 'domino') return;
    knocks[next] = state.time;
    next = (next + 1) % DOMINOES;
    if (state.time - knocks[next] <= 8) grant('dominoes');
  });

  const visited = new Set<string>();
  events.on('pad', (pad) => {
    if (!pad || !HELLO.includes(pad.id)) return;
    visited.add(pad.id);
    if (visited.size === HELLO.length) grant('hello');
  });

  return {
    update() {
      if (car.speed >= 34) grant('flat-out');
      if (car.forwardSpeed <= -9) grant('reverse');
      if (props.knocked >= 50) grant('wreck-50');
      if (props.knocked >= 150) grant('wreck-150');
    },
  };
}
