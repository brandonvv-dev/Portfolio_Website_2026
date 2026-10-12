import type { APIRoute } from 'astro';
import { liveView } from '../../../components/admin/names';
import { live } from '../../../server/analytics';

export const prerender = false;

const DAY_MS = 24 * 60 * 60 * 1000;
const headers = { 'Cache-Control': 'private, no-store' };

/** The LIVE tab's data: visitor counts, hits per minute for the last hour and the newest fifty hits. */
export const GET: APIRoute = async ({ locals }) => {
  // The middleware already answers 401; this keeps the endpoint safe if it is ever mounted elsewhere.
  if (!locals.admin) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  try {
    const now = Date.now();
    return Response.json(liveView(await live(now - DAY_MS), now), { headers });
  } catch (error) {
    console.error('[admin] live read failed:', error instanceof Error ? error.message : 'unknown error');
    return Response.json({ error: 'store' }, { status: 502, headers });
  }
};
