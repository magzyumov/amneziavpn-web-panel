import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type { Request, Response, NextFunction, CookieOptions } from 'express';
import type { AuthPayload } from '../types.js';

const JWT_SECRET = process.env.JWT_SECRET as string;
const SECURE_COOKIE = process.env.NODE_ENV === 'production';

export const AUTH_COOKIE = 'panel_token';
export const CSRF_COOKIE = 'panel_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const COOKIE_BASE: CookieOptions = {
  sameSite: 'strict',
  secure: SECURE_COOKIE,
  path: '/',
};

export function setAuthCookies(res: Response, token: string): void {
  const csrf = crypto.randomBytes(32).toString('hex');
  res.cookie(AUTH_COOKIE, token, {
    ...COOKIE_BASE,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.cookie(CSRF_COOKIE, csrf, {
    ...COOKIE_BASE,
    httpOnly: false,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(AUTH_COOKIE, COOKIE_BASE);
  res.clearCookie(CSRF_COOKIE, COOKIE_BASE);
}

function readToken(req: Request): string | null {
  return req.cookies?.[AUTH_COOKIE] || null;
}

// Расширяем Request с req.user для авторизованных хендлеров.
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthPayload;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = readToken(req);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
  try {
    req.user = jwt.verify(token, JWT_SECRET) as AuthPayload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Double-submit cookie CSRF: для всех не-GET/HEAD/OPTIONS запросов под /api/
// (кроме /api/auth/login и /api/auth/setup) проверяем что X-CSRF-Token из
// заголовка совпадает с panel_csrf cookie. Cookie ставится httpOnly=false,
// поэтому фронт может её прочитать и положить в header.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// req.path не содержит mount-префикс (/api), middleware подключён через app.use('/api', csrfMiddleware).
const CSRF_EXEMPT_PATHS = new Set(['/auth/login', '/auth/setup']);

export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) { next(); return; }
  if (CSRF_EXEMPT_PATHS.has(req.path)) { next(); return; }
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    res.status(403).json({ error: 'CSRF token mismatch' });
    return;
  }
  next();
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyAuth(req: Request): AuthPayload | null {
  const token = readToken(req);
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET) as AuthPayload; } catch { return null; }
}

export { JWT_SECRET };
