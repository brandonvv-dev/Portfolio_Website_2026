import { MQ, countTo, gsap } from '../kit';
import type { MotionCtx } from '../kit';

const WIDE = '(min-width: 900px)';
const SHUT = 'inset(100% 0% 0% 0%)';
const OPEN = 'inset(0% 0% 0% 0%)';

/** Every gallery screenshot in src/data/sites.ts is 1400 by 875. */
const PAGE_WIDTH = 1400;
const PAGE_HEIGHT = 875;

/** The tweens the behaviours below call. Present only while motion is allowed, so reduced motion never reaches GSAP. */
type Motion = {
  open: (dialog: HTMLDialogElement) => void;
  close: (dialog: HTMLDialogElement, done: () => void) => void;
  fold: (panel: HTMLElement, opening: boolean, done: () => void) => void;
};
let motion: Motion | null = null;

function imagesOf(raw: string | undefined): string[] {
  const parsed: unknown = JSON.parse(raw ?? '[]');
  return Array.isArray(parsed) ? parsed.filter((src): src is string => typeof src === 'string') : [];
}

/** The gallery dialog: built on open, cleared on close, opened from #site-<slug> by the game and by links. */
function lightbox(): void {
  const dialog = document.querySelector<HTMLDialogElement>('[data-lightbox]');
  const pages = dialog?.querySelector<HTMLElement>('[data-lb-pages]');
  const title = dialog?.querySelector<HTMLElement>('[data-lb-title]');
  const count = dialog?.querySelector<HTMLElement>('[data-lb-count]');
  const live = dialog?.querySelectorAll<HTMLAnchorElement>('[data-lb-live], [data-lb-foot-live]');
  const plates = document.querySelector<HTMLElement>('.plates');
  if (!dialog || !pages || !title || !count || !live || !plates) return;

  const show = (button: HTMLElement): void => {
    const name = button.dataset.name ?? '';
    const images = imagesOf(button.dataset.images);
    const url = button.dataset.url ?? '';

    title.textContent = name;
    count.textContent = `${images.length} screens`;
    for (const link of live) {
      link.hidden = !url;
      if (url) link.href = url;
      else link.removeAttribute('href');
    }

    // Built on open, not on page load: 189 screenshots is not a page weight
    pages.replaceChildren(
      ...images.map((src, i) => {
        const img = document.createElement('img');
        img.src = src;
        img.alt = `${name} website, screen ${i + 1}`;
        img.width = PAGE_WIDTH;
        img.height = PAGE_HEIGHT;
        img.loading = i < 2 ? 'eager' : 'lazy';
        img.decoding = 'async';
        return img;
      }),
    );
    pages.scrollTop = 0;

    if (!dialog.open) {
      dialog.showModal();
      motion?.open(dialog);
    }
  };

  // The close event arrives a task late, so a native close alone would leave the pages in place for a moment
  const release = (): void => {
    pages.replaceChildren();
    // Clearing the hash lets the same #site-<slug> open the dialog again
    if (location.hash.startsWith('#site-')) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  };

  const shut = (): void => {
    if (!dialog.open) return;
    const done = (): void => {
      dialog.close();
      release();
    };
    if (motion) motion.close(dialog, done);
    else done();
  };

  plates.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-site]') : null;
    if (button) show(button);
  });
  dialog.querySelector('[data-lb-close]')?.addEventListener('click', shut);
  // The dialog has no padding, so a click that lands on the dialog itself is a click on the backdrop
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) shut();
  });
  dialog.addEventListener('cancel', (event) => {
    // Esc is only cancelable after a click or key press on the page; otherwise the browser closes it at once
    if (!motion || !event.cancelable) return;
    event.preventDefault();
    shut();
  });
  dialog.addEventListener('close', release);


  const fromHash = (): void => {
    if (!location.hash.startsWith('#site-')) return;
    const button = document.querySelector<HTMLElement>(`[data-site="${CSS.escape(location.hash.slice(6))}"]`);
    if (button) show(button);
  };
  addEventListener('hashchange', fromHash);
  fromHash();
}

/** Index groups: always open from 900px, one tap opens one list below it. */
function disclosures(): void {
  const wide = matchMedia(WIDE);
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.idx-group button')];

  // The markup is the no-script state (open, buttons disabled); below 900px the buttons come alive
  const sync = (): void => {
    for (const button of buttons) {
      const open = wide.matches || button.closest('.idx-group')?.hasAttribute('data-open') === true;
      button.disabled = wide.matches;
      button.setAttribute('aria-expanded', String(open));
    }
  };

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const group = button.closest<HTMLElement>('.idx-group');
      const panel = group?.querySelector<HTMLElement>('.idx-panel');
      if (!group || !panel) return;

      const opening = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(opening));
      // A closing panel stays displayed until its height has run down
      if (opening) group.setAttribute('data-open', '');
      const settle = (): void => {
        if (!opening) group.removeAttribute('data-open');
      };
      if (motion) motion.fold(panel, opening, settle);
      else settle();
    });
  }

  wide.addEventListener('change', sync);
  sync();
}

export default function init({ mm }: MotionCtx): void {
  lightbox();
  disclosures();

  mm.add(MQ.ok, () => {
    motion = {
      open: (dialog) => {
        gsap.fromTo(
          dialog,
          { clipPath: SHUT },
          { clipPath: OPEN, duration: 0.7, ease: 'power4.inOut', overwrite: true, clearProps: 'clipPath' },
        );
      },
      close: (dialog, done) => {
        gsap.to(dialog, {
          clipPath: SHUT,
          duration: 0.4,
          ease: 'power4.inOut',
          overwrite: true,
          onComplete: () => {
            done();
            gsap.set(dialog, { clearProps: 'clipPath' });
          },
        });
      },
      fold: (panel, opening, done) => {
        gsap.set(panel, { overflow: 'hidden' });
        const settled = (): void => {
          gsap.set(panel, { clearProps: 'height,overflow' });
          done();
        };
        if (opening) {
          gsap.fromTo(
            panel,
            { height: 0 },
            { height: 'auto', duration: 0.6, ease: 'power3.out', overwrite: true, onComplete: settled },
          );
        } else {
          gsap.to(panel, { height: 0, duration: 0.6, ease: 'power3.inOut', overwrite: true, onComplete: settled });
        }
      },
    };

    const number = document.querySelector<HTMLElement>('#sites [data-count]');
    const stopCount = number ? countTo(number, Number(number.dataset.count)) : undefined;

    const segments = gsap.utils.toArray<HTMLElement>('.idx-bar i');
    if (segments.length) {
      gsap.from(segments, {
        scaleX: 0,
        transformOrigin: 'left center',
        duration: 1,
        ease: 'power2.inOut',
        stagger: 0.08,
        scrollTrigger: { trigger: '.idx-bar', start: 'top 90%', once: true },
      });
    }

    return () => {
      motion = null;
      stopCount?.();
    };
  });
}
