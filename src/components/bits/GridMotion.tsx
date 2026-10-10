/* Adapted from React Bits (https://reactbits.dev, github.com/DavidHDev/react-bits). MIT + Commons Clause: use in a site is allowed, redistribution or resale is not. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import './GridMotion.css';

export type GridMotionProps = {
  /** Image URLs; the wall repeats them to fill every row. */
  items: string[];
  rows?: number;
  aspectRatio?: number;
  gap?: number;
  angle?: number;
  tilt?: number;
  speed?: number;
  parallax?: number;
  spotlight?: number;
  dim?: number;
  grayscale?: boolean;
  fade?: number;
};

type Vars = CSSProperties & Record<`--${string}`, string | number>;

type Motion = {
  offsets: number[];
  shifts: number[];
  intro: number;
  pointer: { x: number; y: number; active: boolean };
};

const INERTIA = [0.42, 0.32, 0.26, 0.22];
const PACE = [1, 0.86, 1.12, 0.94];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const wrap = (value: number, total: number) => ((value % total) + total) % total;
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const feather = (side: string, zone: number) => {
  const stops: string[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const alpha = t * t * t * (t * (t * 6 - 15) + 10);
    stops.push(`rgba(0, 0, 0, ${alpha.toFixed(4)}) ${(t * zone).toFixed(2)}%`);
  }
  const mirrored = stops.map((_, i) => {
    const t = (12 - i) / 12;
    const alpha = t * t * t * (t * (t * 6 - 15) + 10);
    return `rgba(0, 0, 0, ${alpha.toFixed(4)}) ${(100 - t * zone).toFixed(2)}%`;
  });
  return `linear-gradient(${side}, ${stops.join(', ')}, ${mirrored.join(', ')})`;
};

const GridMotion = ({
  items,
  rows = 4,
  aspectRatio = 1.33,
  gap = 16,
  angle = -12,
  tilt = 0,
  speed = 24,
  parallax = 0.5,
  spotlight = 0.6,
  dim = 0.35,
  grayscale = false,
  fade = 0.5
}: GridMotionProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const motionRef = useRef<Motion>({ offsets: [], shifts: [], intro: 0, pointer: { x: 0, y: 0, active: false } });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const settings = {
    rows: clamp(Math.round(rows), 1, 12),
    aspect: clamp(aspectRatio, 0.3, 4),
    gap: Math.max(0, gap),
    angle,
    tilt: clamp(tilt, 0, 75),
    speed,
    parallax: clamp(parallax, 0, 1),
    spotlight: clamp(spotlight, 0, 1),
    dim: clamp(dim, 0, 1),
    fade: clamp(fade, 0, 1)
  };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const layout = useMemo(() => {
    const { width, height } = size;
    if (!width || !height || !items.length) return null;
    const turn = (settings.angle * Math.PI) / 180;
    const lean = (settings.tilt * Math.PI) / 180;
    const cos = Math.abs(Math.cos(turn));
    const sin = Math.abs(Math.sin(turn));
    const planeHeight = ((width * sin + height * cos) / Math.max(0.3, Math.cos(lean))) * 1.12;
    const planeWidth = (width * cos + height * sin) * (1 + Math.sin(lean) * 0.9) * 1.12;
    const tileHeight = Math.max(16, (planeHeight - settings.gap * (settings.rows - 1)) / settings.rows);
    const tileWidth = tileHeight * settings.aspect;
    const step = tileWidth + settings.gap;
    const perRow = Math.ceil(planeWidth / step) + 1;
    const period = perRow * step;
    return {
      planeWidth,
      planeHeight,
      tileWidth,
      tileHeight,
      step,
      perRow,
      period,
      copies: Math.ceil(planeWidth / period) + 2,
      top: (planeHeight - settings.rows * tileHeight - (settings.rows - 1) * settings.gap) / 2,
      perspective: Math.max(width, height) * 1.5
    };
  }, [size, items.length, settings.angle, settings.tilt, settings.rows, settings.gap, settings.aspect]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const observer = new ResizeObserver(() => {
      const width = Math.round(root.clientWidth);
      const height = Math.round(root.clientHeight);
      setSize(current => (current.width === width && current.height === height ? current : { width, height }));
    });
    observer.observe(root);
    const motion = motionRef.current;
    const onMove = (event: PointerEvent) => {
      motion.pointer.x = event.clientX;
      motion.pointer.y = event.clientY;
      motion.pointer.active = true;
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerType === 'touch') motion.pointer.active = false;
    };
    const onLeave = () => {
      motion.pointer.active = false;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('blur', onLeave);
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      observer.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('blur', onLeave);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const plane = planeRef.current;
    if (!root || !plane || !layout) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const motion = motionRef.current;
    // Under reduced motion the wall is printed still: no fade-in, no drift, no pointer parallax
    if (reduce) motion.intro = 1;
    const rowEls = Array.from(plane.children) as HTMLElement[];
    const tileEls = rowEls.map(row => Array.from(row.children) as HTMLElement[]);
    const spots = tileEls.map(list => new Float32Array(list.length));
    const written = tileEls.map(list => new Float32Array(list.length));
    let raf = 0;
    let last = performance.now();
    let visible = true;
    let alive = true;
    if (motion.intro >= 1) plane.style.opacity = '1';

    const frame = (now: number) => {
      raf = 0;
      if (!alive) return;
      const s = settingsRef.current;
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;

      if (motion.intro < 1) {
        motion.intro = Math.min(1, motion.intro + dt / 0.9);
        plane.style.opacity = String(1 - (1 - motion.intro) ** 3);
      }

      const rect = root.getBoundingClientRect();
      const scale = rect.width ? root.clientWidth / rect.width : 1;
      const halfWidth = root.clientWidth / 2 || 1;
      const halfHeight = root.clientHeight / 2 || 1;
      const px = (motion.pointer.x - rect.left) * scale - halfWidth;
      const py = (motion.pointer.y - rect.top) * scale - halfHeight;
      const inside = motion.pointer.active && Math.abs(px) <= halfWidth && Math.abs(py) <= halfHeight;
      const lean = (s.tilt * Math.PI) / 180;
      const turn = (s.angle * Math.PI) / 180;
      const depth = layout.perspective;
      let flatY = py;
      let flatX = px;
      if (lean > 0.0001) {
        flatY = (py * depth) / (depth * Math.cos(lean) + py * Math.sin(lean));
        flatX = (px * (depth - flatY * Math.sin(lean))) / depth;
      }
      const planeX = flatX * Math.cos(turn) + flatY * Math.sin(turn);
      const planeY = -flatX * Math.sin(turn) + flatY * Math.cos(turn);
      const nudge = motion.pointer.active ? clamp(px / halfWidth, -1, 1) : 0;
      const reach = (0.6 + 2.2 * s.spotlight) * Math.max(layout.tileWidth, layout.tileHeight);
      const settle = 1 - Math.exp(-dt / 0.22);

      rowEls.forEach((row, r) => {
        const drift = r % 2 ? 1 : -1;
        if (motion.offsets[r] === undefined) {
          motion.offsets[r] = r * layout.step * 0.37;
          motion.shifts[r] = 0;
        }
        if (!reduce) motion.offsets[r] += s.speed * drift * PACE[r % PACE.length] * dt;
        const target = reduce ? 0 : s.parallax * layout.tileWidth * 1.2 * nudge * (r % 2 ? -1 : 1);
        motion.shifts[r] += (target - motion.shifts[r]) * (1 - Math.exp(-dt / INERTIA[r % INERTIA.length]));
        const x = -layout.period + wrap(motion.offsets[r] + motion.shifts[r], layout.period);
        row.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;

        const rowY = layout.top + r * (layout.tileHeight + s.gap) + layout.tileHeight / 2 - layout.planeHeight / 2;
        const left = x - layout.planeWidth / 2 + layout.tileWidth / 2;
        const list = tileEls[r];
        const values = spots[r];
        const marks = written[r];
        for (let k = 0; k < list.length; k++) {
          let wanted = 0;
          if (inside && s.spotlight > 0) {
            const distance = Math.hypot(left + k * layout.step - planeX, rowY - planeY) / reach;
            wanted = 1 - smoothstep(0.25, 1, distance);
          }
          values[k] += (wanted - values[k]) * settle;
          if (Math.abs(values[k] - marks[k]) > 0.004 || (wanted === 0 && values[k] < 0.004 && marks[k] !== 0)) {
            marks[k] = values[k] < 0.004 ? 0 : values[k];
            list[k].style.setProperty('--spot', marks[k].toFixed(3));
          }
        }
      });

      if (visible) raf = requestAnimationFrame(frame);
    };

    const visibility = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (visible && !raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    });
    visibility.observe(root);
    raf = requestAnimationFrame(frame);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      visibility.disconnect();
    };
  }, [layout]);

  const mask =
    settings.fade > 0
      ? `${feather('to right', settings.fade * 34)}, ${feather('to bottom', settings.fade * 44)}`
      : undefined;
  const rootStyle: Vars = {
    '--gm-dim': settings.dim,
    perspective: layout && settings.tilt > 0 ? `${layout.perspective}px` : undefined,
    maskImage: mask,
    WebkitMaskImage: mask,
    maskComposite: mask ? 'intersect' : undefined,
    WebkitMaskComposite: mask ? 'source-in' : undefined
  };
  const planeStyle: Vars | undefined = layout
    ? {
        width: layout.planeWidth,
        height: layout.planeHeight,
        transform: `translate(-50%, -50%) rotateX(${settings.tilt}deg) rotateZ(${settings.angle}deg)`,
        '--gm-gap': `${settings.gap}px`,
        '--gm-tile-w': `${layout.tileWidth}px`,
        '--gm-tile-h': `${layout.tileHeight}px`
      }
    : undefined;

  return (
    <div ref={rootRef} className={`grid-motion${grayscale ? ' grid-motion--gray' : ''}`} style={rootStyle}>
      {layout && (
        <div ref={planeRef} className="grid-motion__plane" aria-hidden="true" style={planeStyle}>
          {Array.from({ length: settings.rows }, (_, r) => (
            <div
              key={r}
              className="grid-motion__row"
              style={{ top: layout.top + r * (layout.tileHeight + settings.gap) }}
            >
              {Array.from({ length: layout.copies * layout.perRow }, (_, k) => (
                <div key={k} className="grid-motion__tile">
                  <img
                    src={items[(r * layout.perRow + (k % layout.perRow)) % items.length]}
                    alt=""
                    width={Math.round(layout.tileWidth)}
                    height={Math.round(layout.tileHeight)}
                    loading="eager"
                    decoding="async"
                    draggable={false}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default GridMotion;