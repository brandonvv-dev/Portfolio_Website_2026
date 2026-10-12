import type { APIRoute } from 'astro';
import { clearedCookie } from '../../../server/auth';

export const prerender = false;

/** Ends the browser's session (the cookie is stateless, so clearing it is the whole job) and shows the login page. */
export const POST: APIRoute = ({ redirect }) => {
  const response = redirect('/admin/platform', 303);
  response.headers.append('Set-Cookie', clearedCookie());
  return response;
};
