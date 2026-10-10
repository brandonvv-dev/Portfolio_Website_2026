import { MQ, gsap } from '../kit';
import type { MotionCtx } from '../kit';

interface Row {
  head: HTMLButtonElement;
  panel: HTMLElement;
}

const isOpen = (head: HTMLElement): boolean => head.getAttribute('aria-expanded') === 'true';

/** What rises when a panel opens: the copy column's paragraphs and the rail column. */
const risers = (panel: HTMLElement): HTMLElement[] =>
  gsap.utils.toArray<HTMLElement>('.panel-copy > *, .panel-shots', panel);

const SHUT = 'inset(100% 0% 0% 0%)';
const OPEN = 'inset(0% 0% 0% 0%)';
const GONE = 'inset(0% 0% 100% 0%)';

export default function init({ mm }: MotionCtx): void {
  const list = document.querySelector<HTMLElement>('#work .work-index');
  if (!list) return;

  const rows: Row[] = gsap.utils.toArray<HTMLButtonElement>('.row-head', list).flatMap((head) => {
    const panel = head.closest('.work-row')?.querySelector<HTMLElement>('.row-panel');
    return panel ? [{ head, panel }] : [];
  });

  // Reduced motion never reaches this branch: a toggle then only flips aria-expanded, and the
  // stylesheet shows or hides the panel on the spot
  let animate = false;
  mm.add(MQ.ok, () => {
    animate = true;
    return () => {
      animate = false;
      for (const { panel } of rows) {
        const kids = risers(panel);
        gsap.killTweensOf([panel, ...kids]);
        gsap.set([panel, ...kids], { clearProps: 'all' });
      }
    };
  });

  function setOpen({ head, panel }: Row, open: boolean, onUpdate?: () => void): void {
    if (isOpen(head) === open) return;
    if (!animate) {
      head.setAttribute('aria-expanded', String(open));
      return;
    }

    // Inline display and height hold the panel on screen while it moves. The stylesheet would
    // hide a closing panel the moment aria-expanded flips; the inline values are handed back to
    // it when the tween ends. offsetHeight is 0 for a closed panel and the live height mid-tween.
    gsap.set(panel, { display: 'block', overflow: 'hidden', height: panel.offsetHeight });
    head.setAttribute('aria-expanded', String(open));
    const settle = (): void => {
      gsap.set(panel, { clearProps: 'display,height,overflow' });
    };

    if (open) {
      gsap.to(panel, {
        height: 'auto',
        duration: 0.7,
        ease: 'power3.out',
        overwrite: true,
        onComplete: settle,
      });
      gsap.fromTo(
        risers(panel),
        { y: 14, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.7,
          ease: 'power3.out',
          stagger: 0.06,
          overwrite: true,
          clearProps: 'transform,opacity',
        },
      );
    } else {
      gsap.to(panel, {
        height: 0,
        duration: 0.5,
        ease: 'power3.inOut',
        overwrite: true,
        onUpdate,
        onComplete: settle,
      });
    }
  }

  rows.forEach((row, at) => {
    row.head.addEventListener('click', () => {
      const open = !isOpen(row.head);
      // A panel closing above the clicked row would carry its head off screen. The scroll follows
      // the collapse frame by frame, or at once without motion, so the head stays under the pointer.
      const y = row.head.getBoundingClientRect().top;
      const hold = (): void =>
        window.scrollBy({ top: row.head.getBoundingClientRect().top - y, behavior: 'instant' });
      if (open) {
        rows.forEach((other, i) => {
          if (i !== at) setOpen(other, false, i < at ? hold : undefined);
        });
      }
      setOpen(row, open);
      if (!animate) hold();
    });
  });

  // The figure caption follows the rail: the first plate that is at least 60 percent in view
  for (const { panel } of rows) {
    const rail = panel.querySelector<HTMLElement>('.rail');
    const caption = panel.querySelector<HTMLElement>('.shots-caption');
    if (!rail || !caption) continue;

    const plates = Array.from(rail.children);
    const inView = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = plates.indexOf(entry.target);
          if (entry.intersectionRatio >= 0.6) inView.add(n);
          else inView.delete(n);
        }
        if (inView.size) {
          caption.textContent = `Fig. ${Math.min(...inView) + 1} of ${plates.length}`;
        }
      },
      { root: rail, threshold: 0.6 },
    );
    plates.forEach((plate) => observer.observe(plate));
  }

  // A plate with the hovered project's first screenshot follows the pointer over closed rows
  mm.add(MQ.fine, () => {
    const peek = document.querySelector<HTMLElement>('#work .peek');
    const img = peek?.querySelector('img');
    if (!peek || !img) return;

    const SIZE = { w: 300, h: 188 };
    const GAP = 28;
    const MARGIN = 8;
    // The plate hangs from the pointer to the lower right, so the hovered title stays readable;
    // it flips to the left or above when the viewport edge is near
    const place = (e: PointerEvent): { x: number; y: number } => ({
      x:
        e.clientX + GAP + SIZE.w > innerWidth - MARGIN
          ? e.clientX - GAP - SIZE.w
          : e.clientX + GAP,
      y:
        e.clientY + GAP + SIZE.h > innerHeight - MARGIN
          ? e.clientY - GAP - SIZE.h
          : e.clientY + GAP,
    });

    gsap.set(peek, { display: 'block', autoAlpha: 0 });
    const xTo = gsap.quickTo(peek, 'x', { duration: 0.45, ease: 'power3.out' });
    const yTo = gsap.quickTo(peek, 'y', { duration: 0.45, ease: 'power3.out' });
    const follow = (e: PointerEvent, snap: boolean): void => {
      const { x, y } = place(e);
      xTo(x, snap ? x : undefined);
      yTo(y, snap ? y : undefined);
    };

    let hovered: HTMLElement | null = null;
    let shown = false;
    const sync = (): void => {
      const head = hovered && !isOpen(hovered) ? hovered : null;
      const src = head?.dataset.peek;
      if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
      if (!!head === shown) return;
      shown = !!head;
      if (shown) {
        gsap.set(peek, { autoAlpha: 1 });
        gsap.fromTo(
          peek,
          { clipPath: SHUT },
          { clipPath: OPEN, duration: 0.5, ease: 'power4.inOut', overwrite: 'auto' },
        );
      } else {
        gsap.to(peek, {
          clipPath: GONE,
          duration: 0.35,
          ease: 'power4.inOut',
          overwrite: 'auto',
          onComplete: () => {
            gsap.set(peek, { autoAlpha: 0 });
          },
        });
      }
    };

    const stop = new AbortController();
    const on = { signal: stop.signal };
    list.addEventListener('pointerenter', (e) => follow(e, true), on);
    list.addEventListener('pointermove', (e) => follow(e, false), on);
    list.addEventListener(
      'pointerover',
      (e) => {
        if (e.pointerType === 'touch') return;
        hovered = e.target instanceof Element ? e.target.closest<HTMLElement>('.row-head') : null;
        sync();
      },
      on,
    );
    list.addEventListener(
      'pointerleave',
      () => {
        hovered = null;
        sync();
      },
      on,
    );
    // Runs after the row's own handler, so aria-expanded is already the new state
    list.addEventListener('click', sync, on);

    return () => {
      stop.abort();
      gsap.killTweensOf(peek);
      gsap.set(peek, { clearProps: 'all' });
    };
  });
}
