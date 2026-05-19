import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encrypt, isEncrypted } from './crypto.js';
import { logger } from './logger.js';
import { extractPeerId } from './peerId.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/panel.db');

let db: Database | null = null;

function assertDb(): Database {
  if (!db) throw new Error('Database not initialized — call getDb() first.');
  return db;
}

export async function getDb(): Promise<Database> {
  if (db) return db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  initSchema();
  migrateEncryption();
  migrateClientPeerIds();
  return db;
}

// Одноразовая миграция: шифрует plaintext password / private_key в существующих записях.
// После успешного запуска ставит settings.enc_migration_v1=done, чтобы при каждом старте
// не дёргать SELECT по таблице servers.
const ENC_MIGRATION_KEY = 'enc_migration_v1';

function migrateEncryption(): void {
  const d = assertDb();

  const flag = d.prepare("SELECT value FROM settings WHERE key = ?");
  flag.bind([ENC_MIGRATION_KEY]);
  const done = flag.step();
  flag.free();
  if (done) return;

  const stmt = d.prepare('SELECT id, password, private_key FROM servers');
  const updates: Array<{ id: string; password: string | null; private_key: string | null }> = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as { id: string; password: string | null; private_key: string | null };
    const newPass = row.password && !isEncrypted(row.password) ? (encrypt(row.password) ?? null) : null;
    const newKey  = row.private_key && !isEncrypted(row.private_key) ? (encrypt(row.private_key) ?? null) : null;
    if (newPass || newKey) {
      updates.push({ id: row.id, password: newPass ?? row.password, private_key: newKey ?? row.private_key });
    }
  }
  stmt.free();
  for (const u of updates) {
    d.run('UPDATE servers SET password = ?, private_key = ? WHERE id = ?', [u.password, u.private_key, u.id]);
  }
  d.run('INSERT INTO settings (key, value) VALUES (?, ?)', [ENC_MIGRATION_KEY, 'done']);
  if (updates.length) {
    logger.info({ count: updates.length }, 'Encrypted plaintext credentials in DB');
  }
  save();
}

// Для существующих БД (где CREATE TABLE clients был без peer_id) — добавляем колонку.
// Затем бэкфиллим peer_id из ранее сохранённой конфигурации клиента:
//   - AWG/WG: client.config содержит "<conf>\n---AMNEZIA_JSON---\n<json>" где json.client_pub_key
//   - Xray: из vless://uuid@... в conf берём UUID
const PEER_ID_MIGRATION_KEY = 'peer_id_migration_v1';

function migrateClientPeerIds(): void {
  const d = assertDb();

  // ALTER TABLE если колонки нет (для уже существующих БД)
  const info = d.exec("PRAGMA table_info('clients')")[0];
  const hasColumn = info?.values.some((row) => row[1] === 'peer_id');
  if (!hasColumn) d.run("ALTER TABLE clients ADD COLUMN peer_id TEXT");

  const flag = d.prepare("SELECT value FROM settings WHERE key = ?");
  flag.bind([PEER_ID_MIGRATION_KEY]);
  const done = flag.step();
  flag.free();
  if (done) return;

  const stmt = d.prepare(`
    SELECT c.id, c.config, p.type FROM clients c
    JOIN protocols p ON p.id = c.protocol_id
    WHERE c.peer_id IS NULL
  `);
  const updates: Array<{ id: string; peer_id: string }> = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as { id: string; config: string | null; type: string };
    const peerId = extractPeerId(row.config, row.type);
    if (peerId) updates.push({ id: row.id, peer_id: peerId });
  }
  stmt.free();
  for (const u of updates) {
    d.run('UPDATE clients SET peer_id = ? WHERE id = ?', [u.peer_id, u.id]);
  }
  d.run('INSERT INTO settings (key, value) VALUES (?, ?)', [PEER_ID_MIGRATION_KEY, 'done']);
  if (updates.length) {
    logger.info({ count: updates.length }, 'Backfilled peer_id for existing clients');
  }
  save();
}

function initSchema(): void {
  const d = assertDb();
  d.run(`
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  `);
  save();
}

// sql.js — in-memory БД, нужно периодически писать снимок на диск.
// save() — синхронная запись прямо сейчас (для миграций, shutdown).
// requestSave() — дебаунс: при шторме run() пишем диск 1 раз в SAVE_DEBOUNCE_MS.
const SAVE_DEBOUNCE_MS = 250;
let saveTimer: NodeJS.Timeout | null = null;
let saveDirty = false;

export function save(): void {
  saveDirty = false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const data = assertDb().export();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function requestSave(): void {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (saveDirty) {
      try { save(); }
      catch (e) { logger.error({ err: e }, 'DB save failed'); }
    }
  }, SAVE_DEBOUNCE_MS);
}

// Вызывается при graceful shutdown — гарантирует, что незаписанные данные на диске.
export function flushSave(): void {
  if (saveDirty) save();
}

type SqlParams = ReadonlyArray<string | number | null | Uint8Array>;

export function query<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T[] {
  const stmt = assertDb().prepare(sql);
  stmt.bind(params as any);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

export function run(sql: string, params: SqlParams = []): void {
  assertDb().run(sql, params as any);
  requestSave();
}

export function queryOne<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T | null {
  const rows = query<T>(sql, params);
  return rows[0] || null;
}
