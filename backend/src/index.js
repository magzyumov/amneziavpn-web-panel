import 'express-async-errors';
import { validateEnv } from './services/env.js';
validateEnv();

import express from 'express';
import cookieParser from 'cookie-parser';
import { getDb } from './services/db.js';
import { initEncryption } from './services/crypto.js';
import { csrfMiddleware } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/servers.js';
import protocolRoutes from './routes/protocols.js';
import clientRoutes from './routes/clients.js';
import subscriptionRoutes from './routes/subscriptions.js';

// Глобальный обработчик необработанных ошибок
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.stack || err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason?.stack || reason);
  process.exit(1);
});

const app = express();
const PORT = process.env.PORT || 3001;

// Доверяем первому proxy (nginx внутри docker network)
app.set('trust proxy', 1);

// CORS не нужен: фронт и API ходят через один nginx (same-origin).
// /sub/:slug потребляется не браузерами (Clash/FLClash) — CORS им безразличен.
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use('/api', csrfMiddleware);

console.log('[startup] Initializing encryption...');
try {
  initEncryption();
  console.log('[startup] Encryption OK');
} catch (err) {
  console.error('[startup] Encryption init FAILED:', err.stack || err.message);
  process.exit(1);
}

console.log('[startup] Initializing database...');
try {
  await getDb();
  console.log('[startup] Database OK');
} catch (err) {
  console.error('[startup] Database init FAILED:', err.stack || err.message);
  process.exit(1);
}

app.use('/api/auth',          authRoutes);
app.use('/api/servers',       serverRoutes);
app.use('/api/protocols',     protocolRoutes);
app.use('/api/clients',       clientRoutes);
app.use('/api/subscriptions', subscriptionRoutes);

// Публичный endpoint для подписок (без /api префикса)
app.use('/', subscriptionRoutes);

app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[startup] Amnezia Panel backend running on :${PORT}`);
});
