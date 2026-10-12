/**
 * Turns the ids the analytics store keeps into words, and a list of recent hits into the LIVE tab.
 * Server only: it reads the site data, which the browser script must not pull in.
 */
import { moreSites } from '../../data/more-sites';
import { siteLinks } from '../../data/site-links';
import { sites } from '../../data/sites';
import { hostOf } from '../../server/analytics';
import type { ClickRow, LiveHit } from '../../server/analytics';
import { lap } from './format';
import type { LiveRow, LiveView, Row } from './format';

/** A fixed table's own entry for an id a stranger chose; never something inherited from Object.prototype. */
const own = (table: Readonly<Record<string, string>>, id: string): string | undefined =>
  Object.hasOwn(table, id) ? table[id] : undefined;

const slugName = new Map(sites.map((site) => [site.slug, site.name]));
/** Live host -> site name, for the twenty shown sites (through site-links) and the rest of the street. */
const hostName = new Map<string, string>(moreSites.map((site) => [hostOf(site.url), site.name]));
for (const [slug, url] of Object.entries(siteLinks)) {
  const name = slugName.get(slug);
  if (name) hostName.set(hostOf(url), name);
}

/** The host of a click target ('host/path' for outside links). */
const targetHost = (target: string): string => target.split('/')[0] ?? target;
/** A client site's name for a host, or undefined for any other host. */
const siteByHost = (host: string): string | undefined => hostName.get(host);

/** Pad ids are 'site:<slug>' or one of these. */
const PADS: Readonly<Record<string, string>> = {
  axiom: 'Axiom',
  linkedin: 'LinkedIn',
  github: 'GitHub',
  email: 'Email',
  cv: 'CV',
  directory: 'The rest of the street',
};
export function padName(id: string): string {
  if (id.startsWith('site:')) return slugName.get(id.slice(5)) ?? id.slice(5);
  return own(PADS, id) ?? id;
}

// Kept in step with AWARDS in src/game/content/awards.ts and WORLD.secrets in src/game/layout.ts.
export const AWARDS: Readonly<Record<string, string>> = {
  air: 'Big air',
  'flat-out': 'Flat out',
  reverse: 'Wrong way',
  'wreck-50': 'Demolition',
  'wreck-150': 'Total demolition',
  dominoes: 'Chain reaction',
  strike: 'Strike',
  handover: 'Handover',
  'whole-street': 'The whole street',
  hello: 'Say hello',
};
export const SECRETS: Readonly<Record<string, string>> = {
  rooftop: 'The roof of the tunnel',
  maze: 'The heart of the maze',
  skate: 'Over the big curve',
};

const regions = new Intl.DisplayNames(['en'], { type: 'region' });
export const countryName = (code: string): string => (code === 'ZZ' ? 'Unknown' : regions.of(code) ?? code);

export const referrerName = (key: string): string =>
  key === 'direct' ? 'Direct or unknown' : key === 'internal' ? 'Own pages' : key;

/** A contact click target ('brandon@host', 'linkedin.com/in/...') as a name and the target itself. */
function contactName(target: string): { label: string; sub: string } {
  const label = target.includes('@')
    ? 'Email'
    : target.startsWith('linkedin.com')
      ? 'LinkedIn'
      : target.startsWith('github.com')
        ? 'GitHub'
        : target;
  return { label, sub: label === target ? '' : target };
}

/** One hit as a category and a short phrase. */
function describe(hit: LiveHit): Pick<LiveRow, 'category' | 'what'> {
  switch (hit.name) {
    case 'view':
      return { category: 'view', what: hit.detail === 'internal' ? 'from own pages' : hit.detail ? `from ${hit.detail}` : 'direct' };
    case 'section':
      return { category: 'section', what: `reached ${hit.detail}` };
    case 'click':
      return { category: 'click', what: hit.detail };
    case 'game_start':
      return { category: 'game', what: 'started the game' };
    case 'game_pad':
      return { category: 'game', what: `reached ${padName(hit.detail)}` };
    case 'game_open':
      return { category: 'game', what: `opened ${padName(hit.detail)}` };
    case 'game_award':
      return { category: 'game', what: `award: ${own(AWARDS, hit.detail) ?? hit.detail}` };
    case 'game_secret':
      return { category: 'game', what: `secret: ${own(SECRETS, hit.detail) ?? hit.detail}` };
    case 'game_lap':
      return { category: 'game', what: `lap ${lap(Number(hit.detail))}` };
    default:
      return { category: 'game', what: hit.name === 'game_leave' ? 'left the game' : hit.name };
  }
}

const MINUTE = 60_000;

/** Recent hits (newest first) as the counts, the per-minute bars and the newest fifty rows of the LIVE tab. */
export function liveView(hits: readonly LiveHit[], now: number): LiveView {
  const visitors = (minutes: number) =>
    new Set(hits.filter((hit) => hit.at > now - minutes * MINUTE).map((hit) => hit.visitor)).size;
  const bars = new Array<number>(60).fill(0);
  for (const hit of hits) {
    const slot = 59 - Math.max(0, Math.floor((now - hit.at) / MINUTE));
    if (slot >= 0) bars[slot] = (bars[slot] ?? 0) + 1;
  }
  return {
    now,
    m5: visitors(5),
    m30: visitors(30),
    m60: visitors(60),
    bars,
    hits: hits.slice(0, 50).map((hit) => ({
      at: hit.at,
      who: hit.visitor.slice(0, 4),
      ...describe(hit),
      path: hit.path,
      country: hit.country,
      device: hit.device,
    })),
  };
}

export function pageName(path: string): { label: string; sub: string } {
  if (path === '/') return { label: 'Home', sub: '/' };
  if (path === '/drive') return { label: 'Drive', sub: '/drive' };
  return { label: 'Other pages', sub: 'anything else on the site' };
}

const KIND_TAG: Readonly<Record<string, string>> = { site: 'Site', cv: 'CV', contact: 'Contact', drive: 'Drive', out: 'Link' };

/** A click as a name and a quieter line: client sites by name and host, contact rows by what they are. */
function clickName(click: ClickRow): { label: string; sub: string } {
  if (click.kind === 'site') {
    const host = targetHost(click.target);
    const name = siteByHost(host);
    return { label: name ?? host, sub: name ? host : '' };
  }
  if (click.kind === 'contact') return contactName(click.target);
  if (click.kind === 'cv') return { label: 'CV', sub: '' };
  if (click.kind === 'drive') return { label: 'Drive', sub: click.target };
  return { label: click.target, sub: '' };
}

/** Clicks of the given kinds as ranked rows; links to the same site (or the same contact row) are added up. */
export function clickRows(clicks: readonly ClickRow[], kinds: readonly string[], tagged = false): Row[] {
  const grouped = new Map<string, Row>();
  for (const click of clicks) {
    if (!kinds.includes(click.kind)) continue;
    const { label, sub } = clickName(click);
    const key = `${click.kind}|${label}`;
    const row = grouped.get(key) ?? { label, sub, value: 0, tag: tagged ? own(KIND_TAG, click.kind) : undefined };
    row.value += click.count;
    grouped.set(key, row);
  }
  return [...grouped.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}
