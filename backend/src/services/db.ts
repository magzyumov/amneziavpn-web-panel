import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encrypt, isEncrypted } from './crypto.js';
import { logger } from './logger.js';

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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (protocol_id) REFERENCES protocols(id) ON DELETE CASCADE
    );

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
