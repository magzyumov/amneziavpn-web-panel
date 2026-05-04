import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getDb, query, queryOne, run } from '../services/db.js';
import { signToken } from '../middleware/auth.js';

const router = Router();

// POST /api/auth/setup — первичная регистрация (только если нет юзеров)
router.post('/setup', async (req, res) => {
  await getDb();
  const existing = query('SELECT id FROM users LIMIT 1');
  if (existing.length > 0) {
    return res.status(400).json({ error: 'Already configured' });
  }
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const hash = await bcrypt.hash(password, 10);
  run('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)', [uuidv4(), username, hash]);
  res.json({ ok: true });
});

// GET /api/auth/status — нужна ли настройка
router.get('/status', async (req, res) => {
  await getDb();
  const existing = query('SELECT id FROM users LIMIT 1');
  res.json({ configured: existing.length > 0 });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  await getDb();
  const { username, password } = req.body;
  const user = queryOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken({ id: user.id, username: user.username });
  res.json({ token, username: user.username });
});

export default router;
