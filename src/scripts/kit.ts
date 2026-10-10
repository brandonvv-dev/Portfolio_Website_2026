import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';

gsap.registerPlugin(ScrollTrigger, SplitText);

const ok = '(prefers-reduced-motion: no-preference)';

/** Media conditions for gsap.matchMedia: every animation lives inside one of these. */
export const MQ = {
  ok,
  wide: `${ok} and (min-width: 900px)`,
  fine: `${ok} and (hover: hover) and (pointer: fine)`,
} as const;

export type MotionCtx = { mm: gsap.MatchMedia };
export type SectionInit = (ctx: MotionCtx) => void;

export { gsap, ScrollTrigger, SplitText };

/** A once-only scroll trigger on el. A null start means the animation plays at once. */
const onceAt = (
  el: Element,
  start: string | null | undefined,
  fallback: string,
): ScrollTrigger.Vars | undefined =>
  start === null ? undefined : { trigger: el, start: start ?? fallback, once: true };

/** Where a line waits under its mask. Display lines are set tighter than their glyphs and the mask has
 * .14em of headroom, so 105 left the tops of tall letters showing; 140 parks the tallest scale step clear. */
export const LINE_HIDDEN = 140;

/** Lines of el rise through their masks. Never split to characters. */
export function splitRise(
  el: Element,
  o: { start?: string | null; delay?: number; stagger?: number; duration?: number } = {},
): SplitText {
  const { start, delay = 0, stagger = 0.08, duration = 1 } = o;
  return SplitText.create(el, {
    type: 'lines',
    mask: 'lines',
    linesClass: 'ln',
    autoSplit: true,
    // The tween is returned so a re-split on resize or font load reverts and re-seeks it
    onSplit: (split: SplitText) =>
      gsap.from(split.lines, {
        yPercent: LINE_HIDDEN,
        duration,
        ease: 'expo.out',
        stagger,
        delay,
        scrollTrigger: onceAt(el, start, 'top 88%'),
      }),
  });
}

/** A hairline draws from its left end (or its top end when axis is y). */
export function drawRule(
  el: Element,
  o: { axis?: 'x' | 'y'; start?: string | null; delay?: number; duration?: number } = {},
): gsap.core.Tween {
  const { axis = 'x', start, delay = 0, duration = 1 } = o;
  return gsap.from(el, {
    ...(axis === 'y'
      ? { scaleY: 0, transformOrigin: 'center top' }
      : { scaleX: 0, transformOrigin: 'left center' }),
    duration,
    ease: 'power3.inOut',
    delay,
    scrollTrigger: onceAt(el, start, 'top 90%'),
  });
}

/** A plate develops: its frame is uncovered from the bottom while the picture settles in. */
export function developPlate(
  frame: Element,
  o: { start?: string | null; delay?: number; scale?: number } = {},
): gsap.core.Timeline {
  const { start, delay = 0, scale = 1.18 } = o;
  const tl = gsap.timeline({
    delay,
    scrollTrigger: onceAt(frame, start, 'top 88%'),
    // The clip is dropped when done so a focus ring on the frame is never cut off
    onComplete: () => {
      gsap.set(frame, { clearProps: 'clipPath' });
    },
  });
  tl.fromTo(
    frame,
    { clipPath: 'inset(100% 0% 0% 0%)' },
    { clipPath: 'inset(0% 0% 0% 0%)', duration: 1, ease: 'power4.inOut' },
    0,
  );
  const img = frame.querySelector('img');
  if (img) tl.fromTo(img, { scale }, { scale: 1, duration: 1.4, ease: 'power3.out' }, 0);
  return tl;
}

/** Counts el up to the final number. Return the cleanup from the mm callback so a flip to reduced motion shows the final number. */
export function countTo(
  el: HTMLElement,
  to: number,
  o: { start?: string | null; duration?: number } = {},
): () => void {
  const { start, duration = 1.6 } = o;
  const state = { n: 0 };
  el.textContent = '0';
  const tween = gsap.to(state, {
    n: to,
    snap: { n: 1 },
    duration,
    ease: 'power2.out',
    scrollTrigger: onceAt(el, start, 'top 88%'),
    onUpdate: () => {
      el.textContent = String(state.n);
    },
  });
  return () => {
    tween.kill();
    el.textContent = String(to);
  };
}
