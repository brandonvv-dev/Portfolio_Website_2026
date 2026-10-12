/**
 * Back-office auth: one signed cookie, no session store.
 * The cookie is `<expiresMs>.<hex HMAC-SHA256(ADMIN_SECRET, expiresMs)>`; logging out clears it
 * in the browser, and it stops working by itself after 12 hours.
 */
import { limited } from './redis';

const COOKIE = 'bvv_admin';
const SESSION_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Hex SHA-256. */
export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export function secret(): string {
  const value = import.meta.env.ADMIN_SECRET;
  if (!value || value.length < 32) throw new Error('ADMIN_SECRET is missing or shorter than 32 characters');
  return value;
}

async function sign(message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Compares in time that depends only on the length, which is public (both sides are hex digests). */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const cookie = (value: string, maxAge: number): string =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${import.meta.env.PROD ? '; Secure' : ''}`;

/** The Set-Cookie value that starts a session. */
export async function sessionCookie(): Promise<string> {
  const expires = String(Date.now() + SESSION_SECONDS * 1000);
  return cookie(`${expires}.${await sign(expires)}`, SESSION_SECONDS);
}

/** The Set-Cookie value that ends it. */
export const clearedCookie = (): string => cookie('', 0);

/** True for a cookie header that carries an unexpired session signed with ADMIN_SECRET. */
export async function verifySession(cookieHeader: string | null): Promise<boolean> {
  const pair = cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  // Exactly '<digits>.<64 lower-case hex>': a cookie with a third segment, or any other shape, is not ours.
  const [, expires = '', mac = ''] = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(pair?.slice(COOKIE.length + 1) ?? '') ?? [];
  if (!expires || Number(expires) < Date.now()) return false;
  return same(mac, await sign(expires));
}

/** The client address as Vercel reports it; empty in dev. */
export const clientIp = (request: Request): string =>
  request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';

/**
 * A stand-in for an address in rate-limit keys, so the address itself is never stored. Salted with
 * ADMIN_SECRET: the 2^32 IPv4 addresses are too few for a bare hash to hide anything.
 */
export async function ipKey(ip: string): Promise<string> {
  return (await sha256(secret() + ip)).slice(0, 16);
}

/**
 * Both fields are compared as SHA-256 digests, always both, so neither the content nor which one
 * was wrong shows in the timing. Five attempts per 15 minutes per address, successful or not.
 */
export async function checkLogin(user: string, password: string, ip: string): Promise<'ok' | 'bad' | 'limited'> {
  if (await limited('login', await ipKey(ip), 5, 15 * 60)) return 'limited';
  const wantUser = import.meta.env.ADMIN_USER;
  const wantPassword = import.meta.env.ADMIN_PASSWORD;
  const [gotUser, gotPassword, expectUser, expectPassword] = await Promise.all([
    sha256(user),
    sha256(password),
    sha256(wantUser ?? ''),
    sha256(wantPassword ?? ''),
  ]);
  const userOk = same(gotUser, expectUser);
  const passwordOk = same(gotPassword, expectPassword);
  // A deployment without the variables must not accept two empty fields.
  return Boolean(wantUser && wantPassword) && userOk && passwordOk ? 'ok' : 'bad';
}
