/**
 * First-party analytics store. This file owns every analytics key; the beacon endpoint writes
 * through record() and the dashboard reads through summary() and live(), never with its own keys.
 *
 * Keys, all under `p` (see redis.ts), where d is a UTC day 'yyyy-mm-dd':
 *   days                 ZSET  every day seen, score yyyymmdd
 *   d:views              HASH  path -> page views
 *   d:visitors           HLL   visitors (the id is salted with the day, so a person is new each day)
 *   d:visitors:<path>    HLL   per-page visitors
 *   d:hours              HASH  UTC hour -> views
 *   d:ref d:country d:device d:browser          HASH  value -> views
 *   d:sections           HASH  home section id -> page loads that reached it
 *   d:clicks             HASH  kind|target -> clicks
 *   d:leave              HASH  secs / n / depth sums (averages are computed on read; /drive is left out)
 *   d:game               HASH  start, land, pad|id, open|id, award|id, secret|id,
 *                              knocked, knocked_n, lap_n, lap_sum, lap_best (min)
 *   d:game:visitors      HLL   visitors who started the game
 *   d:game:pad           HLL   visitors who reached any pad
 *   d:game:cv            HLL   visitors who reached the CV pad
 *   live                 ZSET  last 24 h (and at most LIVE_MAX) of hits, score ms, member ms:visitor:name:path:country:device:detail
 * Every d:* key expires after 400 days. Text a stranger can choose (referrers, outside links, game ids) is
 * counted into a hash that stops taking new fields at MAX_FIELDS; everything else is an allow-list.
 */
import { moreSites } from '../data/more-sites';
import { siteLinks } from '../data/site-links';
import { p, redis } from './redis';

/** 'www.' dropped, so a link and the list of sites agree on the host. */
export const hostOf = (url: string): string => new URL(url).hostname.replace(/^www\./, '');

/** Hosts of the client sites: the only ones a 'site' click may name. */
const SITE_HOSTS: ReadonlySet<string> = new Set([
  ...moreSites.map((site) => hostOf(site.url)),
  ...Object.values(siteLinks).map(hostOf),
]);

/** The home page's sections from the top down; the only ids a 'section' event may name. Keep in step with the page. */
export const SECTIONS = ['top', 'work', 'sites', 'ventures', 'about', 'drive', 'open-source', 'contact'] as const;

/* ------------------------------------------------------------------ events */

const EVENTS = [
  'view',
  'section',
  'click',
  'leave',
  'game_start',
  'game_pad',
  'game_open',
  'game_award',
  'game_secret',
  'game_lap',
  'game_land',
  'game_leave',
] as const;
type EventName = (typeof EVENTS)[number];

const KINDS = ['site', 'cv', 'contact', 'drive', 'out'] as const;
type ClickKind = (typeof KINDS)[number];

/** The address of these links says nothing the kind does not, so each is counted under one fixed target. */
const FIXED_TARGET: Partial<Record<ClickKind, string>> = { cv: '/cv.pdf', drive: '/drive' };

/** Pages that get their own row. Any other path is folded into 'other', so a stranger cannot mint keys. */
const PAGE_KEYS: readonly string[] = ['/', '/drive', 'other'];

export type HitEvent =
  | { name: 'view'; path: string; ref: string }
  | { name: 'section'; path: string; id: string }
  | { name: 'click'; path: string; kind: ClickKind; target: string; label: string }
  | { name: 'leave'; path: string; secs: number; depth: number }
  | { name: 'game_start' | 'game_land'; path: string }
  | { name: 'game_pad' | 'game_open' | 'game_award' | 'game_secret'; path: string; id: string }
  | { name: 'game_lap'; path: string; ms: number }
  | { name: 'game_leave'; path: string; knocked: number; secs: number };

export type Device = 'phone' | 'tablet' | 'desktop';

/** What the server knows about the request; nothing here identifies a person. */
export interface Facts {
  /** UTC 'yyyy-mm-dd'. */
  day: string;
  /** UTC 0-23. */
  hour: number;
  /** ISO 3166 alpha-2, or 'ZZ' when unknown. */
  country: string;
  device: Device;
  browser: string;
  /** 16 hex chars, salted with the day. */
  visitor: string;
}

const MAX_EVENTS = 50;
const HOST = /^[a-z0-9.:-]{1,60}$/i;
const ID = /^[a-z0-9:_-]{1,64}$/i;
const TARGET = /^[\x21-\x7e]{1,100}$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;

type Data = Record<string, string | number>;

const isName = (value: unknown): value is EventName => EVENTS.some((name) => name === value);

/** Data values are short strings or finite numbers; everything else is dropped. */
function cleanData(raw: unknown): Data {
  const out: Data = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
    if (typeof value === 'string' && value.length <= 120) out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

const text = (data: Data, key: string, pattern: RegExp): string | null => {
  const value = data[key];
  return typeof value === 'string' && pattern.test(value) ? value : null;
};

const whole = (data: Data, key: string, max: number): number | null => {
  const value = data[key];
  return typeof value === 'number' ? Math.min(Math.max(Math.round(value), 0), max) : null;
};

function pagePath(raw: unknown): string {
  const path = typeof raw === 'string' ? (raw.split(/[?#]/)[0] ?? '').replace(/(.)\/+$/, '$1') : '';
  return PAGE_KEYS.includes(path) ? path : 'other';
}

function toEvent(raw: unknown): HitEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { name, data } = raw as { name?: unknown; data?: unknown };
  if (!isName(name)) return null;
  const d = cleanData(data);
  const path = pagePath(d.path);

  switch (name) {
    case 'view':
      return { name, path, ref: (text(d, 'ref', HOST) ?? '').toLowerCase() };
    case 'section': {
      const id = SECTIONS.find((section) => section === d.id);
      return id ? { name, path, id } : null;
    }
    case 'click': {
      const declared = KINDS.find((candidate) => candidate === d.kind);
      const href = text(d, 'href', TARGET);
      if (!declared || !href) return null;
      const host = (href.split('/')[0] ?? '').toLowerCase();
      // A link that says it is a client site must be one; any other link that leaves the page is an outside link.
      const kind = declared === 'site' && !SITE_HOSTS.has(host) ? 'out' : declared;
      const target = kind === 'site' ? host : (FIXED_TARGET[kind] ?? href);
      const label = typeof d.label === 'string' ? d.label.replace(CONTROL, '').slice(0, 40) : '';
      return { name, path, kind, target, label };
    }
    case 'leave': {
      const secs = whole(d, 'secs', 3600);
      const depth = whole(d, 'depth', 100);
      return secs === null || depth === null ? null : { name, path, secs, depth };
    }
    case 'game_start':
    case 'game_land':
      return { name, path };
    case 'game_pad':
    case 'game_open':
    case 'game_award':
    case 'game_secret': {
      const id = text(d, 'id', ID);
      return id ? { name, path, id } : null;
    }
    case 'game_lap': {
      const ms = whole(d, 'ms', 3_600_000);
      return ms ? { name, path, ms } : null;
    }
    case 'game_leave': {
      const knocked = whole(d, 'knocked', 100_000);
      const secs = whole(d, 'secs', 86_400);
      return knocked === null || secs === null ? null : { name, path, knocked, secs };
    }
  }
}

/** Turns a request body into the events worth keeping: at most 50, each valid, the rest dropped. */
export function parseEvents(body: unknown): HitEvent[] {
  if (!Array.isArray(body)) return [];
  const events: HitEvent[] = [];
  for (const raw of body.slice(0, MAX_EVENTS)) {
    const event = toEvent(raw);
    if (event) events.push(event);
  }
  return events;
}

/* ------------------------------------------------------------------- write */

const TTL = 400 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A day's hash takes no new field from free text beyond this many. */
const MAX_FIELDS = 200;
/** The newest hits kept for the LIVE tab, whatever the rate. */
const LIVE_MAX = 20_000;
/** Events that would only bury the live feed. */
const NOT_LIVE: readonly EventName[] = ['leave', 'game_land'];

/** HINCRBY for text a stranger chooses: an existing field always counts, a new one only while the hash has room. */
const ADD_CAPPED = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 or redis.call('HLEN', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
end`;

/** A lap time only ever goes down: HGET and HSET in one step, since Redis has no hash min. */
const LAP_BEST = `
local best = redis.call('HGET', KEYS[1], 'lap_best')
if not best or tonumber(best) > tonumber(ARGV[1]) then redis.call('HSET', KEYS[1], 'lap_best', ARGV[1]) end`;

function detail(event: HitEvent): string {
  switch (event.name) {
    case 'view':
      return event.ref;
    case 'section':
    case 'game_pad':
    case 'game_open':
    case 'game_award':
    case 'game_secret':
      return event.id;
    case 'click':
      return event.label || event.target;
    case 'game_lap':
      return String(event.ms);
    default:
      return '';
  }
}

/** Writes every event of one request in a single pipeline. */
export async function record(events: readonly HitEvent[], facts: Facts): Promise<void> {
  if (!events.length) return;
  const { day, visitor } = facts;
  const pipe = redis.pipeline();
  const touched = new Set<string>();
  const key = (suffix: string) => `${p}${day}:${suffix}`;
  const add = (suffix: string, field: string, by = 1) => {
    touched.add(key(suffix));
    pipe.hincrby(key(suffix), field, by);
  };
  const addFree = (suffix: string, field: string) => {
    touched.add(key(suffix));
    pipe.eval(ADD_CAPPED, [key(suffix)], [field, String(MAX_FIELDS)]);
  };
  const seen = (suffix: string) => {
    touched.add(key(suffix));
    pipe.pfadd(key(suffix), visitor);
  };
  const now = Date.now();
  const live: { score: number; member: string }[] = [];

  for (const event of events) {
    switch (event.name) {
      case 'view':
        add('views', event.path);
        seen('visitors');
        seen(`visitors:${event.path}`);
        add('hours', String(facts.hour));
        // 'direct' and 'internal' are fixed words, so they always count; a named host is free text.
        if (event.ref && event.ref !== 'internal') addFree('ref', event.ref);
        else add('ref', event.ref || 'direct');
        add('country', facts.country);
        add('device', facts.device);
        add('browser', facts.browser);
        break;
      case 'section':
        add('sections', event.id);
        break;
      case 'click': {
        const field = `${event.kind}|${event.target}`;
        // Site, CV and Drive clicks have a fixed set of targets, so they can never be crowded out.
        if (event.kind === 'contact' || event.kind === 'out') addFree('clicks', field);
        else add('clicks', field);
        break;
      }
      case 'leave':
        // The game keeps its own time and has no scroll depth, so it would only drag the averages down.
        if (event.path !== '/drive') {
          add('leave', 'secs', event.secs);
          add('leave', 'n');
          add('leave', 'depth', event.depth);
        }
        break;
      case 'game_start':
        add('game', 'start');
        seen('game:visitors');
        break;
      case 'game_pad':
        addFree('game', `pad|${event.id}`);
        seen('game:pad');
        if (event.id === 'cv') seen('game:cv');
        break;
      case 'game_open':
        addFree('game', `open|${event.id}`);
        break;
      case 'game_award':
        addFree('game', `award|${event.id}`);
        break;
      case 'game_secret':
        addFree('game', `secret|${event.id}`);
        break;
      case 'game_land':
        add('game', 'land');
        break;
      case 'game_lap':
        add('game', 'lap_n');
        add('game', 'lap_sum', event.ms);
        pipe.eval(LAP_BEST, [key('game')], [String(event.ms)]);
        break;
      case 'game_leave':
        add('game', 'knocked', event.knocked);
        add('game', 'knocked_n');
        break;
    }
    if (!NOT_LIVE.includes(event.name)) {
      const member = [now, visitor, event.name, event.path, facts.country, facts.device, detail(event)].join(':');
      // The fraction keeps the order of events that arrived in one request.
      live.push({ score: now + live.length / 1000, member });
    }
  }

  pipe.zadd(`${p}days`, { score: Number(day.replaceAll('-', '')), member: day });
  for (const touchedKey of touched) pipe.expire(touchedKey, TTL);
  const [first, ...rest] = live;
  if (first) pipe.zadd(`${p}live`, first, ...rest);
  pipe.zremrangebyscore(`${p}live`, 0, now - DAY_MS);
  pipe.zremrangebyrank(`${p}live`, 0, -(LIVE_MAX + 1));
  await pipe.exec();
}

/* -------------------------------------------------------------------- read */

export interface Ranked {
  key: string;
  count: number;
}
interface PageRow {
  /** A page of the site, or 'other' for every path that is not one. */
  path: string;
  views: number;
  /** Sum of the daily uniques, since a visitor id lasts one day. */
  visitors: number;
}
export interface ClickRow {
  kind: string;
  /** Host and path of the link; own pages are path only. */
  target: string;
  count: number;
}
interface Totals {
  views: number;
  visitors: number;
  /** Seconds the page was visible, per page load. */
  avgSecs: number;
  /** Percent of the page scrolled, per page load. */
  avgDepth: number;
  gameStarts: number;
  /** CV link clicks plus E on the CV pad. */
  cvOpens: number;
}
export interface DayPoint extends Totals {
  day: string;
}
interface GameSummary {
  starts: number;
  /** The funnel, in visitors: started, reached any pad, reached the CV pad. Sums of daily uniques. */
  visitors: number;
  padVisitors: number;
  cvVisitors: number;
  /** id -> count; pad ids are 'site:<slug>', 'axiom', 'linkedin', 'github', 'email', 'cv', 'directory'. */
  pads: Ranked[];
  opens: Ranked[];
  awards: Ranked[];
  secrets: Ranked[];
  lands: number;
  /** Game sessions that ended, and props knocked over per session. */
  sessions: number;
  knockedAvg: number;
  laps: { count: number; bestMs: number | null; avgMs: number | null };
}
export interface Summary {
  range: number;
  /** First and last UTC day of the period, inclusive. */
  from: string;
  to: string;
  /** Exactly `range` points, oldest first, zeros for days without data. */
  days: DayPoint[];
  totals: Totals;
  /** The `range` days before `from`, for the deltas. */
  previous: Totals;
  /** Views by UTC weekday (Monday 0) and UTC hour. */
  heat: number[][];
  pages: PageRow[];
  sections: Ranked[];
  referrers: Ranked[];
  countries: Ranked[];
  devices: Ranked[];
  browsers: Ranked[];
  clicks: ClickRow[];
  game: GameSummary;
}
export interface LiveHit {
  /** Unix ms. */
  at: number;
  visitor: string;
  name: EventName;
  path: string;
  country: string;
  device: string;
  /** Section id, pad id, click label or referrer; may be empty. */
  detail: string;
}

/** Field -> count. Built without a prototype, so a field named 'constructor' or '__proto__' is only a field. */
type Hash = Record<string, number>;
const newHash = (): Hash => Object.create(null) as Hash;

interface Raw {
  views: number;
  visitors: number;
  secs: number;
  leaves: number;
  depth: number;
  starts: number;
  cv: number;
}

const HASHES = ['views', 'hours', 'ref', 'country', 'device', 'browser', 'sections', 'clicks', 'leave', 'game'];
const COUNTS = ['visitors', ...PAGE_KEYS.map((page) => `visitors:${page}`), 'game:visitors', 'game:pad', 'game:cv'];
const PREV_HASHES = ['views', 'clicks', 'leave', 'game'];
const PREV_COUNTS = ['visitors'];

const toNum = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** HGETALL comes back as a flat [field, value, field, value, ...] list when values are not deserialized. */
const toHash = (value: unknown): Hash => {
  const out = newHash();
  if (Array.isArray(value)) {
    for (let i = 0; i + 1 < value.length; i += 2) out[String(value[i])] = toNum(value[i + 1]);
  }
  return out;
};

const sumInto = (into: Hash, from: Hash) => {
  for (const [field, count] of Object.entries(from)) into[field] = (into[field] ?? 0) + count;
};

const total = (hash: Hash, prefix = '') =>
  Object.entries(hash).reduce((n, [field, count]) => (field.startsWith(prefix) ? n + count : n), 0);

const ranked = (hash: Hash, prefix = ''): Ranked[] =>
  Object.entries(hash)
    .filter(([field]) => field.startsWith(prefix))
    .map(([field, count]) => ({ key: field.slice(prefix.length), count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

const ratio = (a: number, b: number) => (b ? a / b : 0);

const totalsOf = (raws: readonly Raw[]): Totals => {
  const sum = (pick: (raw: Raw) => number) => raws.reduce((n, raw) => n + pick(raw), 0);
  const leaves = sum((raw) => raw.leaves);
  return {
    views: sum((raw) => raw.views),
    visitors: sum((raw) => raw.visitors),
    avgSecs: ratio(sum((raw) => raw.secs), leaves),
    avgDepth: ratio(sum((raw) => raw.depth), leaves),
    gameStarts: sum((raw) => raw.starts),
    cvOpens: sum((raw) => raw.cv),
  };
};

const dayOffset = (from: Date, back: number): string =>
  new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - back)).toISOString().slice(0, 10);

const score = (day: string) => Number(day.replaceAll('-', ''));

/**
 * Everything the dashboard shows for the last `range` days (UTC) and the same number of days
 * before them. One read of the day index, then one pipeline for every key of every day that has data.
 */
export async function summary(range: number): Promise<Summary> {
  const n = Math.min(Math.max(Math.trunc(range) || 30, 1), 180);
  const now = new Date();
  const current = Array.from({ length: n }, (_, i) => dayOffset(now, n - 1 - i));
  const before = Array.from({ length: n }, (_, i) => dayOffset(now, 2 * n - 1 - i));
  const from = current[0] ?? '';
  const to = current[n - 1] ?? '';

  const indexed = await redis.zrange<string[]>(`${p}days`, score(before[0] ?? from), score(to), { byScore: true });
  const withData = new Set(indexed);

  const jobs: string[] = [];
  const pipe = redis.pipeline();
  const ask = (day: string, suffix: string, hash: boolean) => {
    jobs.push(`${day}|${suffix}`);
    if (hash) pipe.hgetall(`${p}${day}:${suffix}`);
    else pipe.pfcount(`${p}${day}:${suffix}`);
  };
  const present = current.filter((day) => withData.has(day));
  for (const day of present) {
    for (const suffix of HASHES) ask(day, suffix, true);
    for (const suffix of COUNTS) ask(day, suffix, false);
  }
  for (const day of before.filter((d) => withData.has(d))) {
    for (const suffix of PREV_HASHES) ask(day, suffix, true);
    for (const suffix of PREV_COUNTS) ask(day, suffix, false);
  }
  const results = jobs.length ? await pipe.exec<unknown[]>() : [];
  const cells = new Map(jobs.map((job, i) => [job, results[i]]));
  const hash = (day: string, suffix: string) => toHash(cells.get(`${day}|${suffix}`));
  const count = (day: string, suffix: string) => toNum(cells.get(`${day}|${suffix}`));

  const raw = (day: string): Raw => {
    const leave = hash(day, 'leave');
    const game = hash(day, 'game');
    return {
      views: total(hash(day, 'views')),
      visitors: count(day, 'visitors'),
      secs: leave.secs ?? 0,
      leaves: leave.n ?? 0,
      depth: leave.depth ?? 0,
      starts: game.start ?? 0,
      cv: total(hash(day, 'clicks'), 'cv|') + (game['open|cv'] ?? 0),
    };
  };

  const raws = current.map(raw);
  const views = newHash();
  const merged = {
    hours: newHash(),
    ref: newHash(),
    country: newHash(),
    device: newHash(),
    browser: newHash(),
    sections: newHash(),
    clicks: newHash(),
    game: newHash(),
  };
  const heat = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const pageVisitors = newHash();
  const funnel = { started: 0, pad: 0, cv: 0 };
  let bestMs = 0;

  for (const day of present) {
    sumInto(views, hash(day, 'views'));
    for (const name of Object.keys(merged) as (keyof typeof merged)[]) {
      const part = hash(day, name);
      if (name === 'game') {
        const { lap_best: best = 0, ...counters } = part;
        if (best > 0) bestMs = bestMs ? Math.min(bestMs, best) : best;
        sumInto(merged.game, counters);
      } else sumInto(merged[name], part);
    }
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    const hours = hash(day, 'hours');
    const row = heat[weekday];
    if (row) for (let h = 0; h < 24; h++) row[h] = (row[h] ?? 0) + (hours[String(h)] ?? 0);
    for (const page of PAGE_KEYS) pageVisitors[page] = (pageVisitors[page] ?? 0) + count(day, `visitors:${page}`);
    funnel.started += count(day, 'game:visitors');
    funnel.pad += count(day, 'game:pad');
    funnel.cv += count(day, 'game:cv');
  }

  const { game } = merged;
  const laps = game.lap_n ?? 0;
  const clicks: ClickRow[] = Object.entries(merged.clicks)
    .map(([field, clicked]) => {
      const bar = field.indexOf('|');
      return { kind: field.slice(0, bar), target: field.slice(bar + 1), count: clicked };
    })
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));

  return {
    range: n,
    from,
    to,
    days: current.map((day, i) => ({ day, ...totalsOf(raws[i] ? [raws[i]] : []) })),
    totals: totalsOf(raws),
    previous: totalsOf(before.map(raw)),
    heat,
    pages: PAGE_KEYS.map((path) => ({ path, views: views[path] ?? 0, visitors: pageVisitors[path] ?? 0 }))
      .filter((row) => row.views > 0)
      .sort((a, b) => b.views - a.views),
    sections: ranked(merged.sections),
    referrers: ranked(merged.ref),
    countries: ranked(merged.country),
    devices: ranked(merged.device),
    browsers: ranked(merged.browser),
    clicks,
    game: {
      starts: game.start ?? 0,
      visitors: funnel.started,
      padVisitors: funnel.pad,
      cvVisitors: funnel.cv,
      pads: ranked(game, 'pad|'),
      opens: ranked(game, 'open|'),
      awards: ranked(game, 'award|'),
      secrets: ranked(game, 'secret|'),
      lands: game.land ?? 0,
      sessions: game.knocked_n ?? 0,
      knockedAvg: ratio(game.knocked ?? 0, game.knocked_n ?? 0),
      laps: { count: laps, bestMs: bestMs || null, avgMs: laps ? (game.lap_sum ?? 0) / laps : null },
    },
  };
}

/** Hits since `sinceMs` (unix ms), newest first. The last 24 hours are kept. */
export async function live(sinceMs: number): Promise<LiveHit[]> {
  const rows = await redis.zrange<string[]>(`${p}live`, Math.max(0, Math.floor(sinceMs)), '+inf', { byScore: true });
  const hits: LiveHit[] = [];
  for (const row of rows) {
    const [at, visitor = '', name, path = '', country = '', device = '', ...rest] = row.split(':');
    if (isName(name)) hits.push({ at: toNum(at), visitor, name, path, country, device, detail: rest.join(':') });
  }
  return hits.reverse();
}
