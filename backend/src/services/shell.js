// Утилиты для безопасной интерполяции в shell-команды (ssh.exec / ssh.execSudo).

// Оборачивает значение в одинарные кавычки, экранируя любые ' внутри.
// Использовать ВСЕГДА, когда подставляешь произвольную строку в shell-команду.
export function sh(value) {
  if (value == null) return "''";
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Валидирует целое число в диапазоне. Возвращает число (готовое для интерполяции без кавычек).
export function shInt(value, { min = -Infinity, max = Infinity, label = 'value' } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${label}: expected integer in [${min}, ${max}], got ${value}`);
  }
  return n;
}

// Проверяет, что имя контейнера состоит только из допустимых docker-символов.
// Docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]*
export function assertContainerName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  return name;
}

// Проверяет, что строка — это валидный domain (для SNI и т.п.). Не идеальный regex,
// но достаточный, чтобы блокировать shell-метасимволы.
export function assertDomain(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(value)) {
    throw new Error(`Invalid domain: ${value}`);
  }
  return value;
}

// Проверяет TCP/UDP порт.
export function assertPort(value, label = 'port') {
  return shInt(value, { min: 1, max: 65535, label });
}
