/* Adapted from React Bits (https://reactbits.dev, github.com/DavidHDev/react-bits). MIT + Commons Clause: use in a site is allowed, redistribution or resale is not. */
import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

import './ScrollReveal.css';

gsap.registerPlugin(ScrollTrigger);

export type ScrollRevealProps = {
  text: string;
  className?: string;
  baseOpacity?: number;
  wordAnimationEnd?: string;
};

const ScrollReveal = ({
  text,
  className,
  baseOpacity = 0.14,
  wordAnimationEnd = 'bottom 55%',
}: ScrollRevealProps) => {
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    // Scoped to this paragraph, so other sections' triggers are never touched. A reduced-motion flip while the
    // page is open reverts the tween: the scrub stops and the words return to full opacity
    const mm = gsap.matchMedia(el);
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(
        el.querySelectorAll<HTMLElement>('.sr-word'),
        { opacity: baseOpacity },
        {
          opacity: 1,
          ease: 'none',
          stagger: 0.05,
          scrollTrigger: { trigger: el, start: 'top bottom-=20%', end: wordAnimationEnd, scrub: true },
        },
      );
    });

    return () => mm.revert();
  }, [baseOpacity, wordAnimationEnd]);

  return (
    <p ref={ref} className={className}>
      {text.split(/(\s+)/).map((part, i) =>
        /\S/.test(part) ? (
          <span className="sr-word" key={i}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
};

export default ScrollReveal;
