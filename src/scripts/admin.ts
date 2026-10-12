/**
 * Back-office behaviour: tabs by URL hash, range links that keep the tab, relative times, and the
 * live refresh. Everything else on the page is rendered by the server.
 */
import { ago } from '../components/admin/format';
import type { LiveRow, LiveView } from '../components/admin/format';

const POLL_MS = 15_000;
const TICK_MS = 5_000;

const warn = (error: unknown): void => {
  if (import.meta.env.DEV) console.warn('[admin]', error);
};

// The owner's own visits must not count: the public beacon (src/scripts/track.ts) reads this key.
try {
  localStorage.setItem('notrack', '1');
} catch (error) {
  warn(error);
}

/* ------------------------------------------------------------------- tabs */

const tabLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-tab-link]')];
const rangeLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-range]')];
const tabIds = tabLinks.map((link) => link.dataset.tabLink ?? '');

function select(raw: string, scroll: boolean): void {
  const id = tabIds.includes(raw) ? raw : (tabIds[0] ?? 'overview');
  document.documentElement.dataset.tab = id;
  for (const link of tabLinks) {
    if (link.dataset.tabLink === id) {
      link.setAttribute('aria-current', 'page');
      link.scrollIntoView({ inline: 'center', block: 'nearest' });
    } else link.removeAttribute('aria-current');
  }
  // A range change reloads the page; the tab rides along in the hash.
  for (const link of rangeLinks) link.hash = id;
  if (scroll) window.scrollTo({ top: 0 });
}

if (tabLinks.length) {
  select(location.hash.slice(1), false);
  addEventListener('hashchange', () => select(location.hash.slice(1), true));
}

/* ------------------------------------------------------------------- live */

const root = document.querySelector<HTMLElement>('[data-live-root]');
const chip = document.querySelector<HTMLElement>('[data-live-chip]');
const stamp = document.querySelector<HTMLElement>('[data-live-stamp]');
const list = document.querySelector<HTMLElement>('[data-live-list]');
const empty = document.querySelector<HTMLElement>('[data-live-empty]');
const template = document.querySelector<HTMLTemplateElement>('template[data-live-row]');
const bars = [...document.querySelectorAll<HTMLElement>('[data-live-bars] > i')];

/** Server time minus this computer's: relative times follow the server's clock. */
let skew = Number(root?.dataset.now) - Date.now();
if (!Number.isFinite(skew)) skew = 0;
const serverNow = (): number => Date.now() + skew;

const clock = (): string => new Date().toLocaleTimeString('en-GB');

function isLiveView(value: unknown): value is LiveView {
  return (
    typeof value === 'object' &&
    value !== null &&
    'now' in value &&
    typeof value.now === 'number' &&
    'bars' in value &&
    Array.isArray(value.bars) &&
    'hits' in value &&
    Array.isArray(value.hits)
  );
}

function setText(selector: string, value: string): void {
  for (const element of document.querySelectorAll(selector)) element.textContent = value;
}

function fillRow(row: HTMLElement, hit: LiveRow): void {
  const slot = (name: string): HTMLElement | null => row.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const time = slot('time');
  if (time) {
    time.dataset.at = String(hit.at);
    time.textContent = ago(hit.at, serverNow());
  }
  const category = slot('category');
  if (category) {
    category.dataset.c = hit.category;
    category.textContent = hit.category;
  }
  const values: Record<string, string> = {
    path: hit.path,
    what: hit.what,
    country: hit.country,
    device: hit.device,
    who: `#${hit.who}`,
  };
  for (const [name, value] of Object.entries(values)) {
    const element = slot(name);
    if (element) element.textContent = value;
  }
}

function render(view: LiveView): void {
  skew = view.now - Date.now();
  setText('[data-live="m5"]', String(view.m5));
  setText('[data-live="m30"]', String(view.m30));
  setText('[data-live="m60"]', String(view.m60));
  chip?.setAttribute('data-state', view.m5 ? 'on' : 'idle');

  const busiest = Math.max(...view.bars, 0);
  bars.forEach((bar, i) => {
    const hits = view.bars[i] ?? 0;
    bar.style.setProperty('--h', (hits / Math.max(busiest, 1)).toFixed(3));
    bar.classList.toggle('is-zero', hits === 0);
    bar.title = `${hits} ${hits === 1 ? 'hit' : 'hits'}, ${bars.length - 1 - i} min ago`;
  });
  setText('[data-live-peak]', `peak ${busiest} per minute`);

  if (list && template) {
    const rows: HTMLElement[] = [];
    for (const hit of view.hits) {
      const row = template.content.firstElementChild?.cloneNode(true);
      if (!(row instanceof HTMLElement)) continue;
      fillRow(row, hit);
      rows.push(row);
    }
    list.replaceChildren(...rows);
    list.hidden = rows.length === 0;
    if (empty) empty.hidden = rows.length > 0;
  }
  if (stamp) stamp.textContent = `Updated ${clock()}`;
}

let busy = false;

async function poll(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch('/api/admin/live', { cache: 'no-store', headers: { accept: 'application/json' } });
    if (response.status === 401) {
      location.assign('/admin/platform');
      return;
    }
    if (!response.ok) throw new Error(`live answered ${response.status}`);
    const view: unknown = await response.json();
    if (!isLiveView(view)) throw new Error('live answered with an unexpected shape');
    render(view);
  } catch (error) {
    warn(error);
    chip?.setAttribute('data-state', 'error');
    if (stamp) stamp.textContent = `Could not refresh at ${clock()}; trying again`;
  } finally {
    busy = false;
  }
}

if (root) {
  if (stamp) stamp.textContent = `Loaded ${clock()}`;
  setInterval(() => {
    if (!document.hidden) void poll();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void poll();
  });
  setInterval(() => {
    for (const time of document.querySelectorAll<HTMLElement>('time[data-at]')) {
      const at = Number(time.dataset.at);
      if (time.dataset.at && Number.isFinite(at)) time.textContent = ago(at, serverNow());
    }
  }, TICK_MS);
}
