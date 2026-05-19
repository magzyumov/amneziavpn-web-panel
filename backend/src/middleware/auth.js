import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET;
const SECURE_COOKIE = process.env.NODE_ENV === 'production';

export const AUTH_COOKIE = 'panel_token';
export const CSRF_COOKIE = 'panel_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const COOKIE_BASE = {
  sameSite: 'strict',
  secure: SECURE_COOKIE,
  path: '/',
};

export function setAuthCookies(res, token) {
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

export function clearAuthCookies(res) {
  res.clearCookie(AUTH_COOKIE, COOKIE_BASE);
  res.clearCookie(CSRF_COOKIE, COOKIE_BASE);
}

function readToken(req) {
  return req.cookies?.[AUTH_COOKIE] || null;
}

export function authMiddleware(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
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

export function csrfMiddleware(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT_PATHS.has(req.path)) return next();
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF token mismatch' });
  }
  next();
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyAuth(req) {
  const token = readToken(req);
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

export { JWT_SECRET };
