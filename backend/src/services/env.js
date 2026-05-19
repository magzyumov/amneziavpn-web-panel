// Валидация критичных переменных окружения. Вызывается первой при старте,
// до загрузки роутов и middleware, чтобы фейл происходил с понятным сообщением.

const WEAK_JWT_SECRETS = new Set([
  'change-me-in-production',
  'amnezia-panel-secret-change-me',
]);

function fail(msg) {
  console.error(`[startup] ENV check failed: ${msg}`);
  process.exit(1);
}

export function validateEnv() {
  const jwt = process.env.JWT_SECRET;
  if (!jwt) {
    fail('JWT_SECRET is required. Generate one with: openssl rand -hex 32');
  }
  if (WEAK_JWT_SECRETS.has(jwt)) {
    fail('JWT_SECRET is set to a known default value. Generate one with: openssl rand -hex 32');
  }
  if (jwt.length < 32) {
    fail(`JWT_SECRET must be at least 32 characters (got ${jwt.length}). Generate one with: openssl rand -hex 32`);
  }
}
