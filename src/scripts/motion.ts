/**
 * The one runner. Loaded by Layout.astro for every page except the bare game page.
 * It waits for the three preloaded faces (never longer than 1.2s), runs the generic handlers,
 * runs every sections/<id>.ts init, and adds .fx to <html> last. Until .fx the hidden states in
 * site.css hold; the inline from-states written here replace them.
 */
import { MQ, ScrollTrigger, developPlate, drawRule, gsap, splitRise } from './kit';
import type { MotionCtx, SectionInit } from './kit';

const sections = import.meta.glob<{ default: SectionInit }>('./sections/*.ts', { eager: true });

const FONTS = ['300 1em "Newsreader Display"', '400 1em Newsreader', '400 1em "IBM Plex Mono"'];
const FONT_WAIT_MS = 1200;

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function fontsReady(): Promise<unknown> {
  return Promise.race([
    Promise.allSettled(FONTS.map((font) => document.fonts.load(font))),
    new Promise<void>((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
  ]);
}

/** Selectors below skip [data-load]: those belong to their section's own timeline. */
const pick = <T extends Element>(selector: string): T[] =>
  gsap.utils.toArray<T>(`${selector}:not([data-load])`);

function bindGeneric(mm: gsap.MatchMedia): void {
  mm.add(MQ.ok, () => {
    const lines = gsap.utils.toArray<HTMLElement>('.page-grid i');
    if (lines.length) {
      gsap.from(lines, {
        scaleY: 0,
        transformOrigin: 'center top',
        duration: 1.2,
        ease: 'power3.inOut',
        stagger: 0.07,
      });
    }

    pick('[data-split]').forEach((el) => splitRise(el));

    pick<HTMLElement>('[data-rule]').forEach((el) =>
      drawRule(el, { axis: el.dataset.rule === 'y' ? 'y' : 'x' }),
    );

    const rises = pick('[data-rise]');
    if (rises.length) {
      gsap.set(rises, { y: 16, opacity: 0 });
      ScrollTrigger.batch(rises, {
        interval: 0.1,
        batchMax: 4,
        start: 'top 90%',
        once: true,
        onEnter: (batch) =>
          gsap.to(batch, {
            y: 0,
            opacity: 1,
            duration: 0.8,
            ease: 'power3.out',
            stagger: 0.06,
            overwrite: true,
            clearProps: 'transform,opacity',
          }),
      });
    }

    const plates = pick('[data-plate]');
    if (plates.length) {
      gsap.set(plates, { clipPath: 'inset(100% 0% 0% 0%)' });
      plates.forEach((frame) => {
        const img = frame.querySelector('img');
        if (img) gsap.set(img, { scale: 1.18 });
      });
      ScrollTrigger.batch(plates, {
        batchMax: 3,
        start: 'top 88%',
        once: true,
        onEnter: (batch) =>
          batch.forEach((frame, i) => developPlate(frame, { start: null, delay: i * 0.12 })),
      });
    }
  });

  // Phones play the same sequence at 0.8x the duration
  mm.add(`${MQ.ok} and (max-width: 899px)`, () => {
    gsap.globalTimeline.timeScale(1.25);
    return () => {
      gsap.globalTimeline.timeScale(1);
    };
  });
}

/** In-page anchors: smooth (instant under reduced motion), hash updated, focus moved to the target. */
function bindAnchors(): void {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    const href = link?.getAttribute('href') ?? '';
    // #site-<slug> belongs to the lightbox
    if (href.length < 2 || href.startsWith('#site-')) return;
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    if (!target) return;

    event.preventDefault();
    target.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    history.replaceState(null, '', href);
    if (!target.matches('a, button, input, select, textarea, [tabindex]')) {
      target.setAttribute('tabindex', '-1');
    }
    target.focus({ preventScroll: true });
  });
}

/** Triggers measure the page, so they are measured again when it changes height or the faces land. */
function bindRefresh(): void {
  const main = document.querySelector('main');
  if (main) {
    let timer = 0;
    new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => ScrollTrigger.refresh(), 150);
    }).observe(main);
  }
  void document.fonts.ready.then(() => ScrollTrigger.refresh());
}

async function boot(): Promise<void> {
  await fontsReady();

  const ctx: MotionCtx = { mm: gsap.matchMedia() };
  bindGeneric(ctx.mm);
  for (const [path, section] of Object.entries(sections)) {
    try {
      section.default(ctx);
    } catch (error) {
      console.error(path, error);
    }
  }
  bindAnchors();
  // A ScrollTrigger refresh after a matchMedia change (resize past 900 px, a reduced-motion
  // flip) scrolls the page to the top; put the reader back where they were.
  let savedScroll = 0;
  ScrollTrigger.addEventListener('refreshInit', () => {
    savedScroll = window.scrollY;
  });
  ScrollTrigger.addEventListener('refresh', () => {
    if (savedScroll > 0 && Math.abs(window.scrollY - savedScroll) > 2) window.scrollTo(0, savedScroll);
  });
  bindRefresh();

  document.documentElement.classList.add('fx');
}

void boot();
