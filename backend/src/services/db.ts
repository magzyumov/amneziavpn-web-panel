import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encrypt, isEncrypted } from './crypto.js';
import { logger } from './logger.js';
import { extractPeerId } from './peerId.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/panel.db');

type Db = Database.Database;

let db: Db | null = null;

function assertDb(): Db {
  if (!db) throw new Error('Database not initialized — call getDb() first.');
  return db;
}

// Раньше здесь был sql.js: база целиком жила в памяти, а на диск писался её полный
// дамп (db.export() + writeFileSync) с дебаунсом после каждого run(). Это давало
// два постоянных источника боли:
//   - запись ВСЕЙ базы при любом изменении. Воркер статистики пишет раз в минуту,
//     так что 22-мегабайтный файл переписывался целиком примерно 1440 раз в сутки;
//   - процесс держал свою копию в памяти и затирал файл при следующем сохранении,
//     поэтому любую правку БД снаружи приходилось делать с остановленным backend'ом.
// better-sqlite3 пишет инкрементально и работает с файлом напрямую — оба пункта
// снимаются, а публичный API модуля (query/queryOne/run) остался прежним.
export async function getDb(): Promise<Db> {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  if (DB_PATH !== ':memory:' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  // WAL: читатели не блокируют писателя. NORMAL — обычный компромисс для WAL,
  // потеря возможна только при отказе питания, не при падении процесса.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // foreign_keys НЕ включаем: sql.js их не применял, и включение изменило бы
  // поведение уже написанного кода (он удаляет связанные строки вручную).

  initSchema();
  migrateEncryption();
  migrateClientPeerIds();
  migrateAccessControl();
  purgeOrphanStats();
  return db;
}

// Добавляет колонку, если её ещё нет. Существующие базы создавались более
// ранними версиями initSchema, а sqlite не умеет "ADD COLUMN IF NOT EXISTS".
function addColumnIfMissing(table: string, column: string, ddl: string): boolean {
  const d = assertDb();
  const columns = d.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  if (columns.some(c => c.name === column)) return false;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

// Одноразовая миграция: шифрует plaintext password / private_key в существующих записях.
// После успешного запуска ставит settings.enc_migration_v1=done, чтобы при каждом старте
// не дёргать SELECT по таблице servers.
const ENC_MIGRATION_KEY = 'enc_migration_v1';

function migrateEncryption(): void {
  const d = assertDb();

  const done = d.prepare('SELECT value FROM settings WHERE key = ?').get(ENC_MIGRATION_KEY);
  if (done) return;

  const rows = d.prepare('SELECT id, password, private_key FROM servers').all() as Array<{
    id: string; password: string | null; private_key: string | null;
  }>;

  const updates: Array<{ id: string; password: string | null; private_key: string | null }> = [];
  for (const row of rows) {
    const newPass = row.password && !isEncrypted(row.password) ? (encrypt(row.password) ?? null) : null;
    const newKey  = row.private_key && !isEncrypted(row.private_key) ? (encrypt(row.private_key) ?? null) : null;
    if (newPass || newKey) {
      updates.push({ id: row.id, password: newPass ?? row.password, private_key: newKey ?? row.private_key });
    }
  }

  const upd = d.prepare('UPDATE servers SET password = ?, private_key = ? WHERE id = ?');
  const apply = d.transaction(() => {
    for (const u of updates) upd.run(u.password, u.private_key, u.id);
    d.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(ENC_MIGRATION_KEY, 'done');
  });
  apply();

  if (updates.length) {
    logger.info({ count: updates.length }, 'Encrypted plaintext credentials in DB');
  }
}

// Для существующих БД (где CREATE TABLE clients был без peer_id) — добавляем колонку.
// Затем бэкфиллим peer_id из ранее сохранённой конфигурации клиента:
//   - AWG/WG: client.config содержит "<conf>\n---AMNEZIA_JSON---\n<json>" где json.client_pub_key
//   - Xray: из vless://uuid@... в conf берём UUID
const PEER_ID_MIGRATION_KEY = 'peer_id_migration_v1';

function migrateClientPeerIds(): void {
  const d = assertDb();

  const columns = d.prepare("PRAGMA table_info('clients')").all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'peer_id')) {
    d.exec('ALTER TABLE clients ADD COLUMN peer_id TEXT');
  }

  const done = d.prepare('SELECT value FROM settings WHERE key = ?').get(PEER_ID_MIGRATION_KEY);
  if (done) return;

  const rows = d.prepare(`
    SELECT c.id, c.config, p.type FROM clients c
    JOIN protocols p ON p.id = c.protocol_id
    WHERE c.peer_id IS NULL
  `).all() as Array<{ id: string; config: string | null; type: string }>;

  const updates: Array<{ id: string; peer_id: string }> = [];
  for (const row of rows) {
    const peerId = extractPeerId(row.config, row.type);
    if (peerId) updates.push({ id: row.id, peer_id: peerId });
  }

  const upd = d.prepare('UPDATE clients SET peer_id = ? WHERE id = ?');
  const apply = d.transaction(() => {
    for (const u of updates) upd.run(u.peer_id, u.id);
    d.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(PEER_ID_MIGRATION_KEY, 'done');
  });
  apply();

  if (updates.length) {
    logger.info({ count: updates.length }, 'Backfilled peer_id for existing clients');
  }
}

// Ролевая модель появилась позже базы: до неё любой залогиненный пользователь был
// полным админом. Миграция добавляет колонки в существующие таблицы и раздаёт
// начальные права так, чтобы поведение действующей установки не изменилось:
// все текущие пользователи становятся админами, все текущие клиенты — их.
// Понижать кого-то в правах автоматически нельзя: это отрезало бы живому
// администратору доступ к панели.
const ACCESS_MIGRATION_KEY = 'access_control_migration_v1';

function migrateAccessControl(): void {
  const d = assertDb();

  addColumnIfMissing('users', 'role', "role TEXT NOT NULL DEFAULT 'user'");
  addColumnIfMissing('users', 'client_limit', 'client_limit INTEGER NOT NULL DEFAULT 5');
  addColumnIfMissing('clients', 'user_id', 'user_id TEXT');

  // Лимиты срока и трафика. Дефолты подобраны так, что на существующих клиентах
  // ничего не включается: NULL = бессрочно, 0 = без лимита.
  addColumnIfMissing('users', 'default_expiry_days', 'default_expiry_days INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'default_daily_limit_mb', 'default_daily_limit_mb INTEGER NOT NULL DEFAULT 0');
  // Отметка последнего успешного опроса протокола воркером статистики. Даёт
  // дашборду «живость» сервера бесплатно: SSH туда и так ходит раз в минуту.
  addColumnIfMissing('protocols', 'last_poll_at', 'last_poll_at INTEGER');

  // Кэш фактов, которые узнаются только по SSH. Дашборд читает их из базы и
  // показывает вместе с возрастом — сам он в сеть не ходит принципиально.
  // Дрейф пишет health-запрос страницы сервера, метрики хоста — ручной опрос.
  addColumnIfMissing('protocols', 'drift_image', 'drift_image INTEGER');
  addColumnIfMissing('protocols', 'drift_run_args', 'drift_run_args INTEGER');
  addColumnIfMissing('protocols', 'drift_checked_at', 'drift_checked_at INTEGER');
  addColumnIfMissing('servers', 'dns_installed', 'dns_installed INTEGER');
  addColumnIfMissing('servers', 'probed_at', 'probed_at INTEGER');
  addColumnIfMissing('servers', 'probe_error', 'probe_error TEXT');
  addColumnIfMissing('servers', 'uptime_sec', 'uptime_sec INTEGER');
  addColumnIfMissing('servers', 'load1', 'load1 REAL');
  addColumnIfMissing('servers', 'mem_total_mb', 'mem_total_mb INTEGER');
  addColumnIfMissing('servers', 'mem_used_mb', 'mem_used_mb INTEGER');
  addColumnIfMissing('servers', 'disk_total_mb', 'disk_total_mb INTEGER');
  addColumnIfMissing('servers', 'disk_free_mb', 'disk_free_mb INTEGER');
  addColumnIfMissing('clients', 'expires_at', 'expires_at INTEGER');
  addColumnIfMissing('clients', 'daily_limit_bytes', 'daily_limit_bytes INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('clients', 'suspended_at', 'suspended_at INTEGER');

  const done = d.prepare('SELECT value FROM settings WHERE key = ?').get(ACCESS_MIGRATION_KEY);
  if (done) return;

  const users = d.prepare('SELECT id FROM users ORDER BY created_at ASC').all() as Array<{ id: string }>;
  const firstAdmin = users[0]?.id ?? null;

  const apply = d.transaction(() => {
    // Все, кто уже был в панели, и так имели полный доступ — фиксируем это явно.
    d.prepare("UPDATE users SET role = 'admin', client_limit = 0").run();
    // Клиенты, заведённые до разделения прав, принадлежат первому админу.
    if (firstAdmin) {
      d.prepare('UPDATE clients SET user_id = ? WHERE user_id IS NULL').run(firstAdmin);
    }
    d.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(ACCESS_MIGRATION_KEY, 'done');
  });
  apply();

  if (users.length) {
    logger.info({ users: users.length }, 'Access control: existing users promoted to admin');
  }
}

// Снимки статистики удалённых клиентов раньше оставались в базе навсегда: удаление
// клиента их не трогало, а периодическая чистка работает только по возрасту.
// Это и было основной массой файла БД. Чистим один раз при старте — строки
// недостижимы, эндпоинт статистики требует существующего клиента.
function purgeOrphanStats(): void {
  const d = assertDb();
  const res = d.prepare(
    'DELETE FROM client_stats WHERE client_id NOT IN (SELECT id FROM clients)',
  ).run();
  if (res.changes > 0) {
    logger.info({ removed: res.changes }, 'Purged stats of deleted clients');
    d.exec('VACUUM');
  }
}

function initSchema(): void {
  assertDb().exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 22,
      username TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'password',
      password TEXT,
      private_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS protocols (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT,
      container_name TEXT,
      port INTEGER,
      config TEXT,
      status TEXT DEFAULT 'stopped',
      last_poll_at INTEGER, -- unix sec последнего успешного опроса статистики
      installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      protocol_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT,
      peer_id TEXT, -- pubkey для AWG/WG, UUID для Xray; используется stats-воркером
      user_id TEXT, -- владелец; NULL = «ничей», виден только админам
      expires_at INTEGER,                          -- unix sec; NULL = бессрочно. По истечении клиент удаляется
      daily_limit_bytes INTEGER NOT NULL DEFAULT 0, -- суточный лимит трафика; 0 = без лимита
      suspended_at INTEGER,                        -- unix sec приостановки по лимиту; NULL = активен
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (protocol_id) REFERENCES protocols(id) ON DELETE CASCADE
    );

    -- Снимки накопительной статистики per-client. rx/tx — cumulative bytes
    -- с момента старта контейнера (awg show transfer), могут "обнуляться"
    -- при рестарте контейнера — обработка делается на стороне reader'а.
    CREATE TABLE IF NOT EXISTS client_stats (
      client_id TEXT NOT NULL,
      ts INTEGER NOT NULL,                  -- unix seconds снимка
      rx_bytes INTEGER NOT NULL,            -- cumulative с момента старта контейнера
      tx_bytes INTEGER NOT NULL,
      last_handshake INTEGER,               -- unix seconds, 0 если ни разу не было
      PRIMARY KEY (client_id, ts),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_client_stats_ts ON client_stats(ts);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',      -- 'admin' | 'user'
      client_limit INTEGER NOT NULL DEFAULT 5, -- сколько клиентов юзер заводит сам; 0 = без лимита
      -- Лимиты, которые получают клиенты, заведённые этим пользователем. Сам он
      -- их не выбирает: смысл ограничения в том, что его задаёт администратор.
      default_expiry_days INTEGER NOT NULL DEFAULT 0,    -- 0 = бессрочно
      default_daily_limit_mb INTEGER NOT NULL DEFAULT 0, -- 0 = без лимита
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Что именно разрешено обычному пользователю. Выдаётся протоколами: строка
    -- (user, protocol) даёт доступ и к самому протоколу, и — только на чтение
    -- названия — к серверу, на котором он стоит. Отдельной таблицы user_servers
    -- нет специально: сервер выводится из protocols.server_id, поэтому состояние
    -- «сервер выдан, а протокол нет» невозможно by design.
    -- Админам записи не нужны: им доступно всё.
    CREATE TABLE IF NOT EXISTS user_protocols (
      user_id TEXT NOT NULL,
      protocol_id TEXT NOT NULL,
      PRIMARY KEY (user_id, protocol_id)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_name TEXT NOT NULL,
      server_host TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      yaml_content TEXT,
      vless_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Журнал действий. Имена пользователя и объекта хранятся СНИМКОМ, а не
    -- ссылкой: смысл журнала в том, чтобы пережить удаление того, о чём он
    -- рассказывает. «Кто-то удалил пользователя X» должно читаться и через год,
    -- когда ни автора, ни X уже нет.
    --
    -- Секретов здесь нет и не должно быть: ни паролей, ни приватных ключей, ни
    -- slug'ов подписок (slug — фактически пароль от конфига).
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,          -- unix sec
      user_id TEXT,                 -- NULL, если действие анонимное (неудачный вход)
      username TEXT NOT NULL,       -- снимок имени на момент действия
      role TEXT,                    -- роль на момент действия
      action TEXT NOT NULL,         -- 'client.create', 'auth.login', …
      target_type TEXT,             -- 'client' | 'user' | 'protocol' | 'server' | …
      target_id TEXT,
      target_name TEXT,             -- снимок имени объекта
      details TEXT,                 -- JSON, только безопасные поля
      ip TEXT,
      status TEXT NOT NULL,         -- 'ok' | 'denied' | 'failed'
      http_status INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  `);
}

// Данные попадают на диск сразу, отдельный снимок больше не нужен. Функции
// оставлены, потому что их зовёт код за пределами модуля (graceful shutdown,
// разовые скрипты обслуживания).
export function save(): void { /* no-op: better-sqlite3 пишет синхронно */ }

export function flushSave(): void {
  if (!db) return;
  // Переносит WAL в основной файл и закрывает дескриптор — чтобы после остановки
  // контейнера рядом с panel.db не оставалось -wal/-shm.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* база уже закрыта */ }
  db.close();
  db = null;
}

type SqlParams = ReadonlyArray<string | number | boolean | null | undefined | Uint8Array>;

// sql.js молча принимал undefined и boolean, better-sqlite3 на них бросает.
// Приводим сами, чтобы поведение вызывающего кода не изменилось.
function normalize(params: SqlParams): Array<string | number | null | Uint8Array> {
  return params.map(p => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

export function query<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T[] {
  return assertDb().prepare(sql).all(...normalize(params)) as T[];
}

export function run(sql: string, params: SqlParams = []): void {
  assertDb().prepare(sql).run(...normalize(params));
}

export function queryOne<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T | null {
  return (assertDb().prepare(sql).get(...normalize(params)) as T | undefined) ?? null;
}
