/**
 * One-off: 191 source PNGs (158 MB) -> web-sized WebP, plus a generated data file.
 * Three outputs per site: full gallery images, a 16:10 card, and a small
 * texture for the 3D board (GPU memory, not bandwidth, is the constraint there).
 */
import sharp from 'sharp';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = 'C:/Users/USER-PC/Desktop/WORK/Portfolio/Axiom Top 20 Websites';
const DEST = fileURLToPath(new URL('../public/images/axiom/', import.meta.url));
const DATA = fileURLToPath(new URL('../src/data/sites.ts', import.meta.url));

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const dirs = (await readdir(SRC, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const sites = [];
let written = 0;
let bytes = 0;

for (const dir of dirs) {
  const m = dir.match(/^(\d+)\s*-\s*(.+)$/);
  const num = m ? Number(m[1]) : sites.length + 1;
  const name = (m ? m[2] : dir).trim();
  const slug = slugify(name);

  const outDir = path.join(DEST, slug);
  await mkdir(outDir, { recursive: true });

  const files = (await readdir(path.join(SRC, dir)))
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort();

  const images = [];

  for (const [i, file] of files.entries()) {
    const src = path.join(SRC, dir, file);
    const base = String(i + 1).padStart(2, '0');
    const out = path.join(outDir, `${base}.webp`);

    const info = await sharp(src)
      .resize({ width: 1400, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(out);

    bytes += info.size;
    written++;
    images.push(`/images/axiom/${slug}/${base}.webp`);

    // First shot doubles as the card and the in-game board texture
    if (i === 0) {
      await sharp(src)
        .resize({ width: 900, height: 563, fit: 'cover', position: 'top' })
        .webp({ quality: 80 })
        .toFile(path.join(outDir, 'card.webp'));
      await sharp(src)
        .resize({ width: 768, height: 480, fit: 'cover', position: 'top' })
        .webp({ quality: 72 })
        .toFile(path.join(outDir, 'board.webp'));
    }
  }

  sites.push({ num, name, slug, images });
  console.log(`${String(num).padStart(2, '0')} ${name} -> ${images.length} images`);
}

const ts = `// Generated from "Axiom Top 20 Websites". Regenerate rather than hand-edit.

export interface Site {
  num: number;
  name: string;
  slug: string;
  /** Grid card + 3D board texture live beside the gallery images. */
  card: string;
  board: string;
  images: string[];
}

export const sites: Site[] = ${JSON.stringify(
  sites.map((s) => ({
    num: s.num,
    name: s.name,
    slug: s.slug,
    card: `/images/axiom/${s.slug}/card.webp`,
    board: `/images/axiom/${s.slug}/board.webp`,
    images: s.images,
  })),
  null,
  2
)};
`;

await writeFile(DATA, ts, 'utf8');
console.log(`\n${written} images, ${(bytes / 1048576).toFixed(1)} MB total (was 158 MB)`);
