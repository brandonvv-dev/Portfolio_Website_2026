/**
 * Motion runtime. Deliberately tiny: continuous scroll effects live in CSS
 * (scroll-driven animations), so JS only handles what CSS cannot —
 * enter-once reveals, word splitting, and pointer tilt.
 */

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Split `.reveal-words` text into per-word spans so CSS can stagger them. */
function splitWords() {
  document.querySelectorAll<HTMLElement>('.reveal-words').forEach((el) => {
    if (el.dataset.split) return;
    el.dataset.split = '1';
    const words = (el.textContent ?? '').trim().split(/\s+/);
    el.textContent = '';
    words.forEach((word, i) => {
      const span = document.createElement('span');
      span.className = 'w';
      span.style.setProperty('--i', String(i));
      span.textContent = word;
      el.append(span, document.createTextNode(' '));
    });
  });
}

/**
 * Reveal anything carrying a reveal class once it reaches the fold.
 *
 * Deliberately a scroll sweep rather than an IntersectionObserver: IO only
 * fires when a threshold is *crossed*, so an anchor jump or a fast flick that
 * skips an element in a single frame leaves it hidden forever. Comparing
 * positions can't skip. The list shrinks as elements land, and unhooks itself.
 */
function observeReveals() {
  let targets = [
    ...document.querySelectorAll<HTMLElement>('.reveal, .reveal-blur, .reveal-words'),
  ];
  if (reduced) {
    targets.forEach((el) => el.classList.add('is-in'));
    return;
  }

  let frame = 0;

  const sweep = () => {
    frame = 0;
    const fold = innerHeight * 0.92;
    targets = targets.filter((el) => {
      if (el.getBoundingClientRect().top > fold) return true;
      el.classList.add('is-in');
      return false;
    });
    if (!targets.length) {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
    }
  };

  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(sweep);
  };

  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  sweep();
}

/** Pointer tilt. Writes CSS vars; the transform itself is CSS. */
function bindTilt() {
  if (reduced || matchMedia('(hover: none)').matches) return;

  document.querySelectorAll<HTMLElement>('.tilt').forEach((el) => {
    const max = Number(el.dataset.tilt ?? 7);
    let frame = 0;

    el.addEventListener('pointermove', (e) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        el.classList.add('is-tilting');
        el.style.setProperty('--ry', `${x * max * 2}deg`);
        el.style.setProperty('--rx', `${-y * max * 2}deg`);
      });
    });

    el.addEventListener('pointerleave', () => {
      el.classList.remove('is-tilting');
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    });
  });
}

/**
 * Nav: solidify once the hero is behind us. Apple keeps the bar transparent
 * over the hero, then fades in the blurred backdrop.
 */
function bindNav() {
  const nav = document.querySelector<HTMLElement>('[data-nav]');
  if (!nav) return;
  const sentinel = document.querySelector('[data-nav-sentinel]');
  if (!sentinel) return;
  new IntersectionObserver(
    ([entry]) => nav.classList.toggle('is-solid', !entry.isIntersecting),
    { threshold: 0 }
  ).observe(sentinel);
}

/** Mobile nav sheet. */
function bindNavToggle() {
  const toggle = document.querySelector<HTMLButtonElement>('[data-nav-toggle]');
  const sheet = document.querySelector<HTMLElement>('[data-nav-sheet]');
  if (!toggle || !sheet) return;

  const setOpen = (open: boolean) => {
    toggle.setAttribute('aria-expanded', String(open));
    sheet.toggleAttribute('data-open', open);
    document.body.style.overflow = open ? 'hidden' : '';
  };

  toggle.addEventListener('click', () =>
    setOpen(toggle.getAttribute('aria-expanded') !== 'true')
  );
  sheet.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) setOpen(false);
  });
  addEventListener('keydown', (e) => e.key === 'Escape' && setOpen(false));
}

/**
 * Fallback parallax for browsers without CSS scroll timelines (Firefox today).
 * Cheap: one rAF-throttled scroll handler, transform only.
 */
function parallaxFallback() {
  if (reduced || CSS.supports('animation-timeline', 'view()')) return;

  const items = [...document.querySelectorAll<HTMLElement>('.scroll-parallax')];
  if (!items.length) return;

  let frame = 0;
  const tick = () => {
    frame = 0;
    const h = innerHeight;
    items.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > h + 200) return;
      // -1 above the fold .. +1 below it
      const progress = (r.top + r.height / 2) / h - 0.5;
      const depth = parseFloat(el.style.getPropertyValue('--depth')) || 60;
      el.style.transform = `translate3d(0, ${progress * depth * 2}px, 0)`;
    });
  };

  addEventListener(
    'scroll',
    () => {
      if (!frame) frame = requestAnimationFrame(tick);
    },
    { passive: true }
  );
  tick();
}

function init() {
  splitWords();
  observeReveals();
  bindTilt();
  bindNav();
  bindNavToggle();
  parallaxFallback();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
