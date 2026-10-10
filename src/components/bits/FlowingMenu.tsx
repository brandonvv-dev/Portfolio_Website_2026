/* Adapted from React Bits (https://reactbits.dev, github.com/DavidHDev/react-bits). MIT + Commons Clause: use in a site is allowed, redistribution or resale is not. */
import { useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';

import './FlowingMenu.css';

export type MenuItemData = {
  link: string;
  text: string;
  meta?: string;
  external?: boolean;
};

type Palette = {
  textColor: string;
  marqueeBgColor: string;
  marqueeTextColor: string;
  borderColor: string;
};

type FlowingMenuProps = Palette & {
  items: MenuItemData[];
  /** Accessible name of the nav. */
  label: string;
  /** Seconds the marquee takes to travel one repeat of its text. */
  speed: number;
  bgColor: string;
};

type MenuItemProps = MenuItemData & Palette & { speed: number };

type Edge = 'top' | 'bottom';

const MOTION = '(prefers-reduced-motion: no-preference)';
const FINE_POINTER = '(hover: hover) and (pointer: fine)';
const WIPE = { duration: 0.6, ease: 'expo' };

const MenuItem = ({
  link,
  text,
  meta,
  external,
  speed,
  textColor,
  marqueeBgColor,
  marqueeTextColor,
  borderColor,
}: MenuItemProps) => {
  const itemRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const shutterRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [repeats, setRepeats] = useState(4);

  useEffect(() => {
    const item = itemRef.current;
    const anchor = anchorRef.current;
    const shutter = shutterRef.current;
    const track = trackRef.current;
    const part = track?.firstElementChild;
    if (!item || !anchor || !shutter || !track || !part) return undefined;

    const mm = gsap.matchMedia();
    // Under reduced motion nothing here runs: the stylesheet shows the shutter on hover and focus
    mm.add(MOTION, () => {
      const finePointer = matchMedia(FINE_POINTER);
      let hovered = false;
      let focused = false;
      let open = false;
      let wipe: gsap.core.Timeline | undefined;
      let loop: gsap.core.Tween | undefined;
      let loopWidth = 0;

      // The stylesheet parks the shutter below the row; the tweens take over from the same place
      gsap.set(shutter, { y: 0, yPercent: 101 });
      gsap.set(track, { y: 0, yPercent: -101 });

      const edgeOf = (clientY: number): Edge => {
        const box = item.getBoundingClientRect();
        return clientY - box.top < box.height / 2 ? 'top' : 'bottom';
      };

      /* The shutter follows hover or keyboard focus. The track moves against it so the text holds still
         while the fill sweeps over it. The slide is the only thing that runs; the marquee drifts only
         while the row is open and is paused when the wipe back out has finished. */
      const sync = (edge: Edge) => {
        const wanted = hovered || focused;
        if (wanted === open) return;
        open = wanted;
        const out = edge === 'top' ? -101 : 101;
        const to = open ? 0 : out;
        wipe?.kill();
        // A shutter caught mid-wipe carries on from where it is; only a shut one starts at an edge
        if (open && Math.abs(Number(gsap.getProperty(shutter, 'yPercent'))) > 100) {
          gsap.set(shutter, { yPercent: out });
          gsap.set(track, { yPercent: -out });
        }
        if (open) loop?.play();
        wipe = gsap
          .timeline({
            defaults: WIPE,
            onComplete: () => {
              if (!open) loop?.pause();
            },
          })
          .to(shutter, { yPercent: to }, 0)
          .to(track, { yPercent: -to }, 0);
      };

      const onEnter = (event: MouseEvent) => {
        if (!finePointer.matches) return;
        hovered = true;
        sync(edgeOf(event.clientY));
      };
      const onLeave = (event: MouseEvent) => {
        if (!finePointer.matches) return;
        hovered = false;
        sync(edgeOf(event.clientY));
      };
      // Only keyboard focus floods the row; a tap that focuses a link on a phone must not leave it filled
      const onFocus = () => {
        if (!anchor.matches(':focus-visible')) return;
        focused = true;
        sync('top');
      };
      const onBlur = () => {
        focused = false;
        sync('bottom');
      };

      // The repeats must cover the row and one more, and the loop travels exactly one repeat.
      // A face swap or a resize changes the width, so the loop is rebuilt from the observer.
      const watch = new ResizeObserver(() => {
        const width = part.getBoundingClientRect().width;
        if (!width) return;
        setRepeats(Math.max(2, Math.ceil(item.clientWidth / width) + 1));
        if (width === loopWidth) return;
        loopWidth = width;
        loop?.kill();
        loop = gsap.fromTo(
          track,
          { x: 0 },
          { x: -width, duration: speed, ease: 'none', repeat: -1, paused: !open },
        );
      });
      watch.observe(item);
      watch.observe(part);

      anchor.addEventListener('mouseenter', onEnter);
      anchor.addEventListener('mouseleave', onLeave);
      anchor.addEventListener('focus', onFocus);
      anchor.addEventListener('blur', onBlur);

      return () => {
        watch.disconnect();
        anchor.removeEventListener('mouseenter', onEnter);
        anchor.removeEventListener('mouseleave', onLeave);
        anchor.removeEventListener('focus', onFocus);
        anchor.removeEventListener('blur', onBlur);
        wipe?.kill();
        loop?.kill();
        gsap.set([shutter, track], { clearProps: 'transform' });
      };
    });

    return () => mm.revert();
  }, [speed]);

  return (
    <div className="menu__item" ref={itemRef} style={{ borderColor }}>
      <a
        className="menu__item-link"
        ref={anchorRef}
        href={link}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener' : undefined}
        style={{ color: textColor }}
      >
        <span className="menu__label t-rows">{text}</span>
        {meta && <span className="menu__meta mono-data">{meta}</span>}
      </a>
      <div className="marquee" ref={shutterRef} style={{ backgroundColor: marqueeBgColor }} aria-hidden="true">
        <div className="marquee__inner-wrap">
          <div className="marquee__inner" ref={trackRef}>
            {Array.from({ length: repeats }, (_, index) => (
              <div className="marquee__part" key={index} style={{ color: marqueeTextColor }}>
                <span className="marquee__label t-rows">{text}</span>
                {meta && <span className="marquee__meta mono-data">{meta}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const FlowingMenu = ({ items, label, speed, bgColor, ...palette }: FlowingMenuProps) => (
  <div className="menu-wrap" style={{ backgroundColor: bgColor }}>
    <nav className="menu" aria-label={label}>
      {items.map(item => (
        <MenuItem key={item.link} {...item} {...palette} speed={speed} />
      ))}
    </nav>
  </div>
);

export default FlowingMenu;
