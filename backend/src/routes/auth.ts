import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query, queryOne, run } from '../services/db.js';
import { signToken, setAuthCookies, clearAuthCookies, authMiddleware } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import type { AppUser } from '../types.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
});

const credentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

// POST /api/auth/setup — первичная регистрация (только если нет юзеров)
router.post('/setup', validateBody(credentialsSchema), async (req: Request, res: Response) => {
  const existing = query('SELECT id FROM users LIMIT 1');
  if (existing.length > 0) {
    return res.status(400).json({ error: 'Already configured' });
  }
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  run('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)', [uuidv4(), username, hash]);
  res.json({ ok: true });
});

// GET /api/auth/status — нужна ли настройка
router.get('/status', (_req, res) => {
  const existing = query('SELECT id FROM users LIMIT 1');
  res.json({ configured: existing.length > 0 });
});

// POST /api/auth/login
router.post('/login', loginLimiter, validateBody(credentialsSchema), async (req: Request, res: Response) => {
  const { username, password } = req.body;
  const user = queryOne<AppUser>('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken({ id: user.id, username: user.username });
  setAuthCookies(res, token);
  res.json({ username: user.username });
});

// POST /api/auth/logout
router.post('/logout', (_req, res) => {
  clearAuthCookies(res);
  res.json({ ok: true });
});

// GET /api/auth/me — проверка авторизации (используется фронтом)
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  res.json({ username: req.user!.username });
});

export default router;
