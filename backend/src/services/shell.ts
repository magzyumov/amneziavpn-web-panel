// Утилиты для безопасной интерполяции в shell-команды (ssh.exec / ssh.execSudo).

// Оборачивает значение в одинарные кавычки, экранируя любые ' внутри.
// Использовать ВСЕГДА, когда подставляешь произвольную строку в shell-команду.
export function sh(value: unknown): string {
  if (value == null) return "''";
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

interface IntOpts { min?: number; max?: number; label?: string }

// Валидирует целое число в диапазоне. Возвращает число (готовое для интерполяции без кавычек).
export function shInt(value: unknown, opts: IntOpts = {}): number {
  const { min = -Infinity, max = Infinity, label = 'value' } = opts;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${label}: expected integer in [${min}, ${max}], got ${value}`);
  }
  return n;
}

// Проверяет, что имя контейнера состоит только из допустимых docker-символов.
// Docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]*
export function assertContainerName(name: unknown): string {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  return name;
}

// Проверяет, что строка — это валидный domain (для SNI и т.п.). Не идеальный regex,
// но достаточный, чтобы блокировать shell-метасимволы.
export function assertDomain(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(value)) {
    throw new Error(`Invalid domain: ${value}`);
  }
  return value;
}

// Проверяет TCP/UDP порт.
export function assertPort(value: unknown, label = 'port'): number {
  return shInt(value, { min: 1, max: 65535, label });
}

// Путь для XHTTP/SplitHTTP транспорта Xray. Только безопасные символы пути —
// значение идёт и в shell (через sh), и в JSON-конфиг, поэтому без кавычек/$.
export function assertXrayPath(value: unknown, label = 'xray path'): string {
  const s = String(value);
  if (!/^\/[A-Za-z0-9/_.~-]*$/.test(s)) {
    throw new Error(`Invalid ${label}: expected URL path starting with "/", got ${value}`);
  }
  return s;
}

// Режим XHTTP-транспорта Xray (Xray-core SplitHTTP mode).
export function assertXhttpMode(value: unknown, label = 'xhttp mode'): string {
  const s = String(value).toLowerCase();
  const allowed = ['auto', 'packet-up', 'stream-up', 'stream-one'];
  if (!allowed.includes(s)) {
    throw new Error(`Invalid ${label}: expected one of ${allowed.join('/')}, got ${value}`);
  }
  return s;
}

// Base64-ключ WireGuard/AmneziaWG (32 байта): 43 символа base64 + '='.
// Используется для HeaderProtectionKey (AWG 3.0), который генерится через `awg genkey`.
export function assertWgKey(value: unknown, label = 'key'): string {
  const s = String(value);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(s)) {
    throw new Error(`Invalid ${label}: expected base64-encoded 32-byte key, got ${value}`);
  }
  return s;
}

// Тип "uint32,range" из AmneziaWG 3.0: либо одиночное значение, либо "min-max"
// (min <= max). В отличие от assertMagicHeader допускает 0 — для таймингов это
// валидное значение (AWG трактует отсутствие значения как 0).
export function assertUint32Range(value: unknown, label = 'range'): string {
  const s = String(value);
  const uint32 = { min: 0, max: 4294967295, label };
  if (/^\d{1,10}$/.test(s)) {
    return String(shInt(s, uint32));
  }
  const m = s.match(/^(\d{1,10})-(\d{1,10})$/);
  if (m) {
    const a = shInt(m[1], uint32);
    const b = shInt(m[2], uint32);
    if (a > b) throw new Error(`Invalid ${label}: range start > end (${s})`);
    return `${a}-${b}`;
  }
  throw new Error(`Invalid ${label}: expected uint32 or "min-max" range, got ${value}`);
}

// Magic header AmneziaWG. В AWG 2.0 это либо uint32, либо диапазон "min-max"
// (оба значения uint32, min <= max). Возвращает нормализованную строку, безопасную
// для интерполяции в shell (только цифры и дефис).
export function assertMagicHeader(value: unknown, label = 'magic header'): string {
  const s = String(value);
  const uint32 = { min: 1, max: 4294967295, label };
  if (/^\d{1,10}$/.test(s)) {
    return String(shInt(s, uint32));
  }
  const m = s.match(/^(\d{1,10})-(\d{1,10})$/);
  if (m) {
    const a = shInt(m[1], uint32);
    const b = shInt(m[2], uint32);
    if (a > b) throw new Error(`Invalid ${label}: range start > end (${s})`);
    return `${a}-${b}`;
  }
  throw new Error(`Invalid ${label}: expected uint32 or "min-max" range, got ${value}`);
}
