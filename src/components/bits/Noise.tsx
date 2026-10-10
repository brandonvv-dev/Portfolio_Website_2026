/* Adapted from React Bits (https://reactbits.dev, github.com/DavidHDev/react-bits). MIT + Commons Clause: use in a site is allowed, redistribution or resale is not. */
import { useEffect, useRef, useState } from 'react';

import './Noise.css';

export type NoiseProps = {
  opacity: number;
  fps: number;
  contrast: number;
};

const TILE = 256;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const generator = (seed: number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const paintTile = (contrast: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = ctx.createImageData(TILE, TILE);
  const data = image.data;
  const random = generator(1013904223);
  const range = 0.5 + contrast * 1.1;
  for (let i = 0; i < data.length; i += 4) {
    const value = clamp(0.5 + (random() + random() - 1) * range, 0, 1) * 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
};

const Grain = ({ opacity, fps, contrast }: NoiseProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const grainRef = useRef<HTMLDivElement>(null);
  const rate = clamp(fps, 0, 60);

  useEffect(() => {
    const grain = grainRef.current;
    if (!grain) return undefined;
    let alive = true;
    let url = '';
    paintTile(clamp(contrast, 0, 1))?.toBlob(blob => {
      if (!alive || !blob) return;
      url = URL.createObjectURL(blob);
      grain.style.backgroundImage = `url("${url}")`;
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [contrast]);

  useEffect(() => {
    const root = rootRef.current;
    const grain = grainRef.current;
    if (!root || !grain || rate <= 0) return undefined;
    let raf = 0;
    let last = 0;
    let visible = true;

    const tick = (now: number) => {
      raf = 0;
      if (now - last >= 1000 / rate) {
        last = now;
        grain.style.backgroundPosition = `${(Math.random() * TILE).toFixed(1)}px ${(Math.random() * TILE).toFixed(1)}px`;
      }
      if (visible) raf = requestAnimationFrame(tick);
    };
    const wake = () => {
      if (!raf && visible) raf = requestAnimationFrame(tick);
    };

    const visibility = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (visible) wake();
    });
    visibility.observe(root);
    wake();

    return () => {
      cancelAnimationFrame(raf);
      visibility.disconnect();
    };
  }, [rate]);

  return (
    <div ref={rootRef} className="noise" aria-hidden="true">
      <div
        ref={grainRef}
        className="noise__grain"
        style={{ opacity: clamp(opacity, 0, 1), backgroundSize: `${TILE}px ${TILE}px` }}
      />
    </div>
  );
};

/* Nothing on the server, under 900px (the island never hydrates) or under reduced motion. */
const Noise = (props: NoiseProps) => {
  const [still, setStill] = useState(true);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setStill(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return still ? null : <Grain {...props} />;
};

export default Noise;
