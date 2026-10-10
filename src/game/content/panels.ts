import type { GameContext, GameModule, Pad } from '../types';

/** A card image is requested only when the car is this close to its pad. */
const NEAR = 40;
const NEAR_SQ = NEAR * NEAR;
/** Seconds between proximity checks: four a second is plenty at driving speed. */
const CHECK = 0.25;

const query = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const isMailOrTel = (url: string) => /^(mailto|tel):/i.test(url);

interface Built {
  article: HTMLElement;
  pad: Pad;
  /** Set once the card's src has been assigned. */
  shot: HTMLImageElement | null;
}

function build(pad: Pad): Built {
  const article = el('article', 'panel');
  const kicker = el('p', 'panel-kicker', pad.kicker);
  kicker.style.color = pad.accent;
  article.append(kicker, el('h2', undefined, pad.title));
  if (pad.body) article.append(el('p', 'panel-desc', pad.body));
  if (pad.tags.length) {
    const tags = el('ul', 'panel-tech');
    for (const tag of pad.tags) tags.append(el('li', undefined, tag));
    article.append(tags);
  }
  let shot: HTMLImageElement | null = null;
  if (pad.image) {
    shot = el('img', 'panel-shot');
    shot.alt = '';
    shot.decoding = 'async';
    article.append(shot);
  }
  const links = el('div', 'panel-links');
  for (const link of pad.links) {
    const a = el('a', link.primary ? 'primary' : 'muted', `${link.label} \u203a`);
    a.href = link.href;
    if (link.download) a.setAttribute('download', '');
    // A link followed in place would unload the game; mailto and tel would leave a blank tab.
    else if (!isMailOrTel(link.href)) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    links.append(a);
  }
  article.append(links);
  if (pad.open) {
    const hint = el('p', 'panel-enter');
    hint.append(el('kbd', undefined, 'E'), ' to open it');
    article.append(hint);
  }
  return { article, pad, shot };
}

const createPanels = (ctx: GameContext): GameModule => {
  const { events, store, state, car } = ctx;
  const host = query('[data-panel]');
  const toasts = query('[data-toasts]');
  const openButton = query<HTMLButtonElement>('[data-open]');
  const sitesChip = query('[data-sites]');
  const secretsChip = query('[data-secrets]');

  const built = ctx.places.pads.map(build);
  if (host) host.append(...built.map((b) => b.article));
  const byPad = new Map<Pad, Built>(built.map((b) => [b.pad, b]));
  const pending = built.filter((b) => b.shot);
  const siteTotal = ctx.places.pads.filter((p) => p.kind === 'site').length;
  const secretTotal = ctx.places.secrets.length;

  let active: Built | undefined;

  /**
   * Runs inside the E keydown and the Open button's click, never from the frame: a tab opened
   * outside a gesture is a popup and gets blocked.
   */
  const open = () => {
    const url = state.pad?.open;
    if (!url) return;
    if (isMailOrTel(url)) location.href = url;
    else window.open(url, '_blank', 'noopener');
  };
  ctx.input.onInteract = open;
  openButton?.addEventListener('click', open);

  /* ---------------------------------------------------------------- toasts */

  const queue: { id: string; title: string; body: string }[] = [];
  let showing: string | null = null;

  const next = () => {
    const toast = queue.shift();
    if (!toast || !toasts) {
      showing = null;
      return;
    }
    showing = toast.id;
    const node = el('div', 'toast');
    node.append(el('b', undefined, toast.title), el('span', undefined, toast.body));
    node.addEventListener('animationend', () => {
      node.remove();
      next();
    });
    toasts.append(node);
  };

  events.on('toast', (id, title, body) => {
    if (id === showing || queue.some((q) => q.id === id)) return;
    queue.push({ id, title, body });
    if (showing === null) next();
  });

  /* -------------------------------------------------------------- progress */

  const writeChips = () => {
    if (sitesChip) sitesChip.textContent = `${store.saved.sites.length}/${siteTotal}`;
    if (secretsChip) secretsChip.textContent = `${store.saved.secrets.length}/${secretTotal}`;
  };
  writeChips();

  events.on('pad', (pad) => {
    active?.article.classList.remove('is-active');
    active = pad ? byPad.get(pad) : undefined;
    active?.article.classList.add('is-active');
    openButton?.classList.toggle('is-active', !!pad?.open);
    if (!pad) return;
    events.emit('sound', 'chime');
    if (pad.kind !== 'site') return;
    const slug = pad.id.slice('site:'.length);
    const sites = store.saved.sites;
    if (sites.includes(slug)) return;
    sites.push(slug);
    store.save();
    writeChips();
    if (sites.length === siteTotal) {
      events.emit('toast', 'all-sites', 'The whole street', `All ${siteTotal} client sites visited.`);
      events.emit('sound', 'award');
    }
  });

  let sinceCheck = CHECK;

  return {
    update(dt) {
      const secrets = ctx.places.secrets;
      const found = store.saved.secrets;
      let changed = false;
      for (let i = 0; i < secrets.length; i++) {
        const s = secrets[i];
        if (car.position.y < s.minY || found.includes(s.id)) continue;
        const dx = car.position.x - s.x;
        const dz = car.position.z - s.z;
        if (dx * dx + dz * dz > s.radius * s.radius) continue;
        found.push(s.id);
        changed = true;
        events.emit('toast', s.id, 'Secret found', s.label);
        events.emit('sound', 'award');
      }
      if (changed) {
        store.save();
        writeChips();
      }

      sinceCheck += dt;
      if (sinceCheck < CHECK) return;
      sinceCheck = 0;
      for (let i = pending.length - 1; i >= 0; i--) {
        const { pad, shot } = pending[i];
        const dx = car.position.x - pad.x;
        const dz = car.position.z - pad.z;
        if (dx * dx + dz * dz > NEAR_SQ || !shot || !pad.image) continue;
        shot.src = pad.image;
        pending.splice(i, 1);
      }
    },
  };
};

export default createPanels;
