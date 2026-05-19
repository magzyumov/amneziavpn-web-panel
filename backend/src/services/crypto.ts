import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

function loadOrGenerateKey(): Buffer {
  const fromEnv = process.env.PANEL_ENCRYPTION_KEY;
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error('PANEL_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
    }
    return Buffer.from(fromEnv, 'hex');
  }
  // Fallback: persistent key file next to the DB. Auto-generated on first run.
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'panel.db');
  const keyPath = path.join(path.dirname(dbPath), 'encryption.key');
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(`Invalid key file at ${keyPath}: expected 64 hex chars`);
    }
    return Buffer.from(raw, 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  logger.warn({ keyPath }, 'PANEL_ENCRYPTION_KEY not set — generated new key; back up alongside DB or set env var');
  return key;
}

function getKey(): Buffer {
  if (!cachedKey) cachedKey = loadOrGenerateKey();
  return cachedKey;
}

export function initEncryption(): void {
  getKey();
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encrypt(plaintext: string | null | undefined): string | null | undefined {
  if (plaintext == null || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(value: string | null | undefined): string | null | undefined {
  if (value == null || value === '') return value;
  if (!isEncrypted(value)) return value;
  const data = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ct = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
