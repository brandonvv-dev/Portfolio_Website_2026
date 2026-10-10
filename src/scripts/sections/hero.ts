import { LINE_HIDDEN, MQ, gsap, splitRise } from '../kit';
import type { SectionInit } from '../kit';

function need<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`hero: ${selector} not found`);
  return el;
}

/** The cover loads as one sequence, t=0 at fx: masthead, name, contents, plate, standfirst, CV. */
const init: SectionInit = ({ mm }) => {
  const hero = document.getElementById('top');
  if (!hero) return;

  const all = <T extends Element>(selector: string) => gsap.utils.toArray<T>(selector, hero);
  const cells = all('.hero-cell > [data-load]');
  const rule = need(hero, '.hero-rule');
  const h1 = need(hero, 'h1');
  const lines = all('h1 .ln');
  const label = need(hero, '.hero-toc-label > [data-load]');
  const hairs = all('.hero-toc li > i');
  const rows = all('.hero-row');
  const plate = need(hero, '.hero-fig .plate');
  const img = need(plate, 'img');
  const standfirst = need(hero, '.t-standfirst');
  const late = all('.hero-cv > a, .hero-fig figcaption');

  mm.add(MQ.ok, () => {
    const tl = gsap.timeline();
    tl.from(cells, { yPercent: 110, duration: 0.8, ease: 'expo.out', stagger: 0.06, clearProps: 'transform' }, 0.15)
      .from(rule, { scaleX: 0, transformOrigin: 'left center', duration: 1, ease: 'power3.inOut', clearProps: 'transform,transformOrigin' }, 0.15)
      .from(lines, { yPercent: LINE_HIDDEN, duration: 1.25, ease: 'expo.out', stagger: 0.14, clearProps: 'transform' }, 0.3)
      .from(
        hairs,
        { scaleX: 0, transformOrigin: 'left center', duration: 0.9, ease: 'power3.inOut', stagger: 0.06, clearProps: 'transform,transformOrigin' },
        0.76,
      )
      .from([label, ...rows], { yPercent: 110, duration: 0.8, ease: 'expo.out', stagger: 0.06, clearProps: 'transform' }, 0.7)
      .from(late, { opacity: 0, duration: 0.7, ease: 'power3.out', clearProps: 'opacity' }, 1.5)
      // The plate develops from the bottom edge; the picture settles before the shutter is fully open
      .fromTo(
        plate,
        { clipPath: 'inset(100% 0% 0% 0%)' },
        { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.1, ease: 'power4.inOut', clearProps: 'clipPath' },
        0.9,
      )
      .fromTo(img, { scale: 1.12 }, { scale: 1, duration: 0.65, ease: 'power3.out', clearProps: 'transform' }, 0.9);

    const split = splitRise(standfirst, { start: null, delay: 1.1, duration: 0.9, stagger: 0.06 });
    return () => split.revert();
  });

  // The name drifts up a little faster than the page over the first screen
  mm.add(MQ.wide, () => {
    gsap.to(h1, {
      yPercent: -8,
      ease: 'none',
      scrollTrigger: {
        trigger: hero,
        start: 'top top',
        end: () => `+=${window.innerHeight}`,
        scrub: 0.5,
        invalidateOnRefresh: true,
      },
    });
  });
};

export default init;
