import { SURFACES } from '../layout';
import type { GameContext, GameModule } from '../types';

/** Canvas pixels, and the rotated world they cover in metres. */
const SIZE = 640;
const SPAN = 370;
const K = SIZE / SPAN;
const SIDE = 0.70711;
const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Rotated so that up-screen is up: the Avenue runs straight up the map, as it does in the view. */
const mapX = (x: number, z: number): number => SIZE / 2 + SIDE * (x - z) * K;
const mapY = (x: number, z: number): number => SIZE / 2 + SIDE * (x + z) * K;

/** Where a label sits against its point: beside it off the Avenue, above it on the Avenue. */
const side = (x: number, z: number): string => {
  const across = x - z;
  if (Math.abs(across) < 8) return 'translate(-50%,-125%)';
  return across > 0 ? 'translate(10px,-50%)' : 'translate(calc(-100% - 10px),-50%)';
};

export default function createChart(ctx: GameContext): GameModule {
  const hud = document.querySelector('[data-hud]');
  if (!hud) return {};
  const { car, state, events, store, places } = ctx;

  let modal: HTMLDivElement | null = null;
  let frame: HTMLDivElement;
  let marker: HTMLDivElement;
  let canvas: CanvasRenderingContext2D;
  let drawn = -1;
  let markX = Number.NaN;
  let markZ = Number.NaN;

  const trace = (g: CanvasRenderingContext2D, points: readonly (readonly [number, number])[]): void => {
    g.beginPath();
    points.forEach(([x, z], i) => (i ? g.lineTo(mapX(x, z), mapY(x, z)) : g.moveTo(mapX(x, z), mapY(x, z))));
  };

  const draw = (): void => {
    const g = canvas;
    g.fillStyle = '#86cf62';
    g.fillRect(0, 0, SIZE, SIZE);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const s of SURFACES) {
      g.fillStyle = g.strokeStyle = s.colour;
      if (s.kind === 'disc') {
        g.beginPath();
        g.arc(mapX(s.x, s.z), mapY(s.x, s.z), s.radius * K, 0, Math.PI * 2);
        g.fill();
      } else if (s.kind === 'polygon') {
        trace(g, s.points);
        g.fill();
      } else {
        trace(g, s.points);
        g.lineWidth = s.width * K;
        g.stroke();
      }
    }
    g.lineWidth = 2;
    for (const pad of places.pads) {
      g.beginPath();
      g.arc(mapX(pad.x, pad.z), mapY(pad.x, pad.z), 5, 0, Math.PI * 2);
      g.fillStyle = g.strokeStyle = pad.accent;
      if (pad.kind !== 'site' || store.saved.sites.includes(pad.id.slice(5))) g.fill();
      else g.stroke();
    }
    g.fillStyle = '#141a22';
    for (const at of places.respawns) {
      g.beginPath();
      g.arc(mapX(at.x, at.z), mapY(at.x, at.z), 3, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#f0b429';
    for (const zone of places.secrets) {
      if (!store.saved.secrets.includes(zone.id)) continue;
      g.beginPath();
      g.arc(mapX(zone.x, zone.z), mapY(zone.x, zone.z), 6, 0, Math.PI * 2);
      g.fill();
    }
    drawn = store.saved.sites.length + store.saved.secrets.length;
  };

  const build = (): HTMLDivElement => {
    const root = document.createElement('div');
    root.className = 'screen';
    root.hidden = true;
    // A tap outside the map closes it, which a phone has no key for.
    root.addEventListener('click', (e) => {
      if (e.target === root) toggle(false);
    });
    frame = document.createElement('div');
    frame.style.cssText = 'position:relative;width:min(80vmin,640px);aspect-ratio:1';
    const surface = document.createElement('canvas');
    surface.width = surface.height = SIZE;
    surface.style.cssText = 'width:100%;height:100%;display:block;border-radius:12px';
    const g = surface.getContext('2d');
    if (!g) throw new Error('2d canvas unavailable');
    canvas = g;
    marker = document.createElement('div');
    marker.style.cssText =
      'position:absolute;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#ff3b30;border:2px solid #fff;pointer-events:none';
    frame.append(surface);
    for (const at of places.respawns) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hud-btn';
      button.textContent = at.name;
      button.style.cssText = `position:absolute;left:${((mapX(at.x, at.z) / SIZE) * 100).toFixed(2)}%;top:${((mapY(at.x, at.z) / SIZE) * 100).toFixed(2)}%;transform:${side(at.x, at.z)};font-size:0.6875rem;padding:0.2rem 0.55rem`;
      button.addEventListener('click', () => {
        events.emit('reset', at.name);
        toggle(false);
      });
      frame.append(button);
    }
    frame.append(marker);
    root.append(frame);
    document.body.append(root);
    return root;
  };

  const toggle = (open: boolean): void => {
    if (open) {
      modal ??= build();
      if (drawn !== store.saved.sites.length + store.saved.secrets.length) draw();
      markX = Number.NaN;
    }
    if (modal) modal.hidden = !open;
  };
  const isOpen = (): boolean => modal !== null && !modal.hidden;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hud-btn';
  button.textContent = 'Map';
  button.addEventListener('click', () => toggle(!isOpen()));
  hud.append(button);

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyM') {
      if (!e.repeat && (isOpen() || state.phase === 'driving')) toggle(!isOpen());
    } else if (isOpen() && (e.code === 'Escape' || DRIVE_KEYS.has(e.code))) toggle(false);
  });

  return {
    update() {
      if (!isOpen()) return;
      const x = Math.round(car.position.x);
      const z = Math.round(car.position.z);
      if (x === markX && z === markZ) return;
      markX = x;
      markZ = z;
      const w = frame.clientWidth / SIZE;
      marker.style.transform = `translate(${(mapX(x, z) * w).toFixed(1)}px,${(mapY(x, z) * w).toFixed(1)}px)`;
    },
  };
}
