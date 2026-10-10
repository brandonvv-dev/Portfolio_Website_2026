import { LINE_HIDDEN, MQ, ScrollTrigger, gsap } from '../kit';
import type { MotionCtx } from '../kit';

const CLOSED = 'inset(0% 0% 100% 0%)';
const OPEN = 'inset(0% 0% 0% 0%)';

const pad = (n: number): string => String(n).padStart(2, '0');

function need<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nav: ${selector} is missing`);
  return el;
}

function span(text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

export default function init({ mm }: MotionCtx): void {
  const toggle = need<HTMLButtonElement>('[data-nav-toggle]');
  const closeButton = need<HTMLButtonElement>('[data-nav-close]');
  const sheet = need<HTMLElement>('[data-nav-sheet]');
  const label = need<HTMLElement>('[data-nav-here]');
  const rule = need<HTMLElement>('.nav-rule');
  const firstLink = need<HTMLAnchorElement>('.sheet-link');

  const lines = gsap.utils.toArray<HTMLElement>('.ln', sheet);
  const wide = matchMedia('(min-width: 900px)');

  // The motion context while animation is allowed, null under reduced motion. Tweens made from
  // event handlers go through it so a change of the setting reverts them mid-flight.
  let fx: gsap.Context | null = null;
  let isOpen = false;
  let behind: HTMLElement[] = [];

  /* ---- Sheet ---- */
  function lock(on: boolean): void {
    for (const el of [document.documentElement, document.body]) el.style.overflow = on ? 'hidden' : '';
    for (const el of behind) el.inert = false;
    behind = on
      ? [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== sheet)
      : [];
    for (const el of behind) el.inert = true;
  }

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    gsap.killTweensOf(sheet);
    sheet.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    lock(true);
    fx?.add(() => {
      gsap.fromTo(
        sheet,
        { clipPath: CLOSED },
        { clipPath: OPEN, duration: 0.6, ease: 'power4.inOut', clearProps: 'clipPath' },
      );
      gsap.fromTo(
        lines,
        { yPercent: LINE_HIDDEN },
        { yPercent: 0, duration: 0.9, ease: 'expo.out', stagger: 0.05, delay: 0.2, clearProps: 'transform' },
      );
    });
    firstLink.focus({ preventScroll: true });
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    toggle.setAttribute('aria-expanded', 'false');
    // Unlocked before the shutter finishes so an anchor click scrolls and focuses its target at once
    lock(false);
    toggle.focus();
    if (!fx) {
      sheet.hidden = true;
      return;
    }
    fx.add(() => {
      gsap.to(sheet, {
        clipPath: CLOSED,
        duration: 0.4,
        ease: 'power4.inOut',
        overwrite: true,
        onComplete: () => {
          sheet.hidden = true;
          gsap.set(sheet, { clearProps: 'clipPath' });
        },
      });
    });
  }

  toggle.addEventListener('click', () => (isOpen ? close() : open()));
  closeButton.addEventListener('click', close);
  sheet.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  wide.addEventListener('change', () => {
    if (wide.matches) close();
  });

  /* ---- Running head ---- */
  const sections = gsap.utils.toArray<HTMLElement>('main > section[data-folio]');
  const links = gsap.utils.toArray<HTMLElement>('[data-nav] [data-section]');
  const active = new Set<HTMLElement>();
  let shown = '';

  for (const el of document.querySelectorAll<HTMLElement>('[data-sheet-no]')) {
    const at = sections.findIndex((section) => section.id === el.dataset.sheetNo);
    if (at >= 0) el.textContent = pad(at + 1);
  }

  /** The old text leaves upward while the new text enters from below, inside the label's clip. */
  function roll(text: string): void {
    if (!fx) {
      label.replaceChildren(...(text ? [span(text)] : []));
      return;
    }
    const spans = [...label.querySelectorAll<HTMLElement>(':scope > span')];
    gsap.killTweensOf(spans);
    // Anything but the newest is left over from a roll that was cut short
    for (const stale of spans.slice(0, -1)) stale.remove();
    const out = spans.at(-1);
    const next = text ? span(text) : null;
    if (next) label.append(next);
    fx.add(() => {
      if (out) {
        gsap.to(out, { yPercent: -100, duration: 0.4, ease: 'power3.inOut', onComplete: () => out.remove() });
      }
      if (next) {
        gsap.fromTo(
          next,
          { yPercent: 100 },
          { yPercent: 0, duration: 0.4, ease: 'power3.inOut', clearProps: 'transform' },
        );
      }
    });
  }

  function show(): void {
    const current = sections.findLast((section) => active.has(section));
    const text = current ? `${pad(sections.indexOf(current) + 1)} ${current.dataset.folio ?? ''}` : '';
    for (const link of links) {
      if (current && link.dataset.section === current.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
    if (text === shown) return;
    shown = text;
    roll(text);
  }

  // Wayfinding is behaviour, not decoration, so it also runs under reduced motion (the label then swaps)
  for (const section of sections) {
    ScrollTrigger.create({
      trigger: section,
      start: 'top 55%',
      end: 'bottom 55%',
      onToggle: (self) => {
        if (self.isActive) active.add(section);
        else active.delete(section);
        show();
      },
    });
  }

  /* ---- Motion ---- */
  mm.add(MQ.ok, (ctx) => {
    fx = ctx;
    gsap.from(rule, { scaleX: 0, duration: 1, ease: 'power3.inOut', delay: 0.1, clearProps: 'transform' });
    return () => {
      fx = null;
      // A shutter cut short never reaches its onComplete
      sheet.hidden = !isOpen;
      label.replaceChildren(...(shown ? [span(shown)] : []));
    };
  });
}
