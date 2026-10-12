import { defineMiddleware } from 'astro:middleware';
import { verifySession } from './server/auth';

const LOGIN_PAGE = '/admin/platform';

/** What a visitor without a session may reach: the login page itself, and the login form's POST. */
const open = (path: string, method: string): boolean =>
  (path === LOGIN_PAGE && (method === 'GET' || method === 'HEAD')) ||
  (path === `${LOGIN_PAGE}/login` && method === 'POST');

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.admin = false;

  // Match on the decoded, lower-cased path so '/%61dmin' and '//admin' cannot slip past the prefix.
  let path: string;
  try {
    path = decodeURIComponent(context.url.pathname)
      .toLowerCase()
      .replace(/\/{2,}/g, '/')
      .replace(/(.)\/$/, '$1');
  } catch {
    return new Response(null, { status: 400 });
  }

  const api = path === '/api/admin' || path.startsWith('/api/admin/');
  if (!api && path !== '/admin' && !path.startsWith('/admin/')) return next();

  const admin = await verifySession(context.request.headers.get('cookie'));
  context.locals.admin = admin;

  let response: Response;
  if (admin || open(path, context.request.method)) response = await next();
  else if (api) response = Response.json({ error: 'unauthorized' }, { status: 401 });
  else response = context.redirect(LOGIN_PAGE, 303);

  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Cache-Control', 'private, no-store');
  // The back office is never framed, never sniffed into another type, and never named in a Referer.
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
});
