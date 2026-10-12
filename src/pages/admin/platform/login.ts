import type { APIRoute } from 'astro';
import { checkLogin, clientIp, sessionCookie } from '../../../server/auth';

export const prerender = false;

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/**
 * Astro's own cross-site form check only runs when the whole site is `output: 'server'`; this one is
 * 'static', so the login form checks it itself. A browser always sends Origin on a POST, and it must
 * name the host the request was made to (Vercel's x-forwarded-host, or the Host header in dev).
 */
function fromThisSite(request: Request): boolean {
  const origin = request.headers.get('origin')?.replace(/^https?:\/\//, '');
  if (!origin) return false;
  return [request.headers.get('x-forwarded-host'), request.headers.get('host')].includes(origin);
}

/**
 * The login form's POST. Success starts a session; a refusal goes back to the login page, whose card
 * words `?e=bad` or `?e=limited` itself. It is a redirect, not a render, so reloading the page after a
 * failure never offers to send the password again. The message is the same whichever field was wrong.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  if (!fromThisSite(request)) return new Response(null, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response(null, { status: 400 });
  }

  const result = await checkLogin(field(form, 'user'), field(form, 'password'), clientIp(request));
  if (result !== 'ok') return redirect(`/admin/platform?e=${result}`, 303);

  const response = redirect('/admin/platform', 303);
  response.headers.append('Set-Cookie', await sessionCookie());
  return response;
};
