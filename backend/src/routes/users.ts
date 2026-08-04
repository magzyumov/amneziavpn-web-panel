// Управление пользователями панели. Роутер целиком административный.
//
// Публичной регистрации нет намеренно: аккаунт в этой панели = доступ к VPN,
// поэтому пользователей заводит администратор.
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query, queryOne, run } from '../services/db.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { grantedProtocolIds, setUserProtocols, revokeUserGrants } from '../services/access.js';
import type { AppUser, UserRole } from '../types.js';

const router = Router();
router.use(authMiddleware);
router.use(requireAdmin);

const createSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
  role: z.enum(['admin', 'user']).optional().default('user'),
  clientLimit: z.coerce.number().int().min(0).max(1000).optional().default(5),
  // Лимиты, которые получат клиенты этого пользователя. 0 = без ограничения.
  defaultExpiryDays: z.coerce.number().int().min(0).max(3650).optional().default(0),
  defaultDailyLimitMb: z.coerce.number().int().min(0).max(1024 * 1024).optional().default(0),
  protocolIds: z.array(z.string()).optional().default([]),
});

// Все поля необязательны: форма редактирования шлёт только изменённое.
const updateSchema = z.object({
  password: z.string().min(8).max(256).optional(),
  role: z.enum(['admin', 'user']).optional(),
  clientLimit: z.coerce.number().int().min(0).max(1000).optional(),
  defaultExpiryDays: z.coerce.number().int().min(0).max(3650).optional(),
  defaultDailyLimitMb: z.coerce.number().int().min(0).max(1024 * 1024).optional(),
  protocolIds: z.array(z.string()).optional(),
});

interface UserRow {
  id: string;
  username: string;
  role: UserRole;
  client_limit: number;
  default_expiry_days: number;
  default_daily_limit_mb: number;
  created_at: string;
  clients_count: number;
}

function listUsers(): Array<UserRow & { protocolIds: string[] }> {
  const rows = query<UserRow>(`
    SELECT u.id, u.username, u.role, u.client_limit, u.created_at,
           u.default_expiry_days, u.default_daily_limit_mb,
           (SELECT COUNT(*) FROM clients c WHERE c.user_id = u.id) AS clients_count
    FROM users u
    ORDER BY u.created_at ASC
  `);
  return rows.map(u => ({ ...u, protocolIds: grantedProtocolIds(u.id) }));
}

function countAdmins(): number {
  return queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")?.n ?? 0;
}

// GET /api/users
router.get('/', (_req, res) => res.json(listUsers()));

// POST /api/users — завести пользователя
router.post('/', validateBody(createSchema), async (req: Request, res: Response) => {
  const {
    username, password, role, clientLimit, defaultExpiryDays, defaultDailyLimitMb, protocolIds,
  } = req.body as z.infer<typeof createSchema>;

  if (queryOne('SELECT id FROM users WHERE username = ?', [username])) {
    return res.status(409).json({ error: 'Пользователь с таким именем уже существует' });
  }

  const id = uuidv4();
  const hash = await bcrypt.hash(password, 10);
  run(`INSERT INTO users (id, username, password_hash, role, client_limit, default_expiry_days, default_daily_limit_mb)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, username, hash, role, clientLimit, defaultExpiryDays, defaultDailyLimitMb]);
  setUserProtocols(id, protocolIds);

  const created = listUsers().find(u => u.id === id);
  res.json(created);
});

// PUT /api/users/:id — пароль / роль / лимит / выданные протоколы
router.put('/:id', validateBody(updateSchema), async (req: Request, res: Response) => {
  const target = queryOne<AppUser>('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  const {
    password, role, clientLimit, defaultExpiryDays, defaultDailyLimitMb, protocolIds,
  } = req.body as z.infer<typeof updateSchema>;

  // Последний админ не должен уметь разжаловать сам себя: панель осталась бы
  // без администратора, и вернуть права было бы уже нечем.
  if (role === 'user' && target.role === 'admin' && countAdmins() <= 1) {
    return res.status(400).json({ error: 'Это последний администратор — сначала назначьте другого' });
  }

  if (password) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 10), target.id]);
  }
  if (role !== undefined)        run('UPDATE users SET role = ? WHERE id = ?', [role, target.id]);
  if (clientLimit !== undefined) run('UPDATE users SET client_limit = ? WHERE id = ?', [clientLimit, target.id]);
  if (protocolIds !== undefined) setUserProtocols(target.id, protocolIds);
  // Дефолты действуют на клиентов, которые пользователь заведёт ПОСЛЕ правки.
  // Уже выпущенные не трогаем: менять их задним числом — это молча обрезать
  // человеку работающий доступ. Для них есть PUT /api/clients/:id/limits.
  if (defaultExpiryDays !== undefined) {
    run('UPDATE users SET default_expiry_days = ? WHERE id = ?', [defaultExpiryDays, target.id]);
  }
  if (defaultDailyLimitMb !== undefined) {
    run('UPDATE users SET default_daily_limit_mb = ? WHERE id = ?', [defaultDailyLimitMb, target.id]);
  }

  res.json(listUsers().find(u => u.id === target.id));
});

// DELETE /api/users/:id
router.delete('/:id', (req: Request, res: Response) => {
  const target = queryOne<AppUser>('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!target) return res.json({ ok: true }); // уже удалён

  if (target.id === req.user!.id) {
    return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  }
  if (target.role === 'admin' && countAdmins() <= 1) {
    return res.status(400).json({ error: 'Это последний администратор — удалять его нельзя' });
  }

  // Клиентов НЕ удаляем: за каждым стоит живой peer на сервере, и молча рвать
  // людям связь при удалении аккаунта неправильно. Они становятся «ничьими» —
  // видны только админам, которые решат, отозвать их или передать другому.
  const orphaned = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM clients WHERE user_id = ?', [target.id])?.n ?? 0;
  run('UPDATE clients SET user_id = NULL WHERE user_id = ?', [target.id]);
  revokeUserGrants(target.id);
  run('DELETE FROM users WHERE id = ?', [target.id]);

  res.json({ ok: true, orphanedClients: orphaned });
});

export default router;
