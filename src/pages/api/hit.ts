import type { APIRoute } from 'astro';
import { parseEvents, record } from '../../server/analytics';
import type { Device, Facts, HitEvent } from '../../server/analytics';
import { clientIp, ipKey, secret, sha256 } from '../../server/auth';
import { limited } from '../../server/redis';

export const prerender = false;

const MAX_BODY = 20_000;
const BOT = /bot|spider|crawl|slurp|facebookexternalhit|lighthouse/i;

const device = (ua: string): Device =>
  /ipad|tablet|android(?!.*mobile)/i.test(ua) ? 'tablet' : /mobi|iphone|ipod|android/i.test(ua) ? 'phone' : 'desktop';

const browser = (ua: string): string => {
  if (/edg(e|a|ios)?\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/samsungbrowser/i.test(ua)) return 'Samsung';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/chrome|crios/i.test(ua)) return 'Chrome';
  return /safari/i.test(ua) ? 'Safari' : 'Other';
};

/** Always the same answer, so the endpoint tells a caller nothing about what was kept. */
const done = () => new Response(null, { status: 204 });

export const POST: APIRoute = async ({ request }) => {
  const ua = request.headers.get('user-agent') ?? '';
  if (!ua || BOT.test(ua)) return done();

  const body = await request.text();
  if (body.length > MAX_BODY) return done();
  let events: HitEvent[];
  try {
    events = parseEvents(JSON.parse(body));
  } catch {
    return done();
  }
  if (!events.length) return done();

  // The beacon is fire-and-forget, so a store that is down costs the visitor nothing: log it and answer 204.
  try {
    const ip = clientIp(request);
    // By address alone first: a rotating user agent must not buy more requests.
    if (await limited('hitip', await ipKey(ip), 300, 60)) return done();

    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    // No raw address is stored: the id is a day-salted hash, so it cannot follow anyone across days.
    const visitor = (await sha256(secret() + day + ip + ua)).slice(0, 16);
    if (await limited('hit', visitor, 60, 60)) return done();

    const country = request.headers.get('x-vercel-ip-country') ?? '';
    const facts: Facts = {
      day,
      hour: now.getUTCHours(),
      country: /^[A-Z]{2}$/.test(country) ? country : 'ZZ',
      device: device(ua),
      browser: browser(ua),
      visitor,
    };
    await record(events, facts);
  } catch (error) {
    console.error('[hit] not stored:', error instanceof Error ? error.message : 'unknown error');
  }
  return done();
};

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { Allow: 'POST' } });
