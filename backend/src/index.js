import 'express-async-errors';
import { validateEnv } from './services/env.js';
validateEnv();

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { getDb, flushSave } from './services/db.js';
import { initEncryption } from './services/crypto.js';
import { csrfMiddleware } from './middleware/auth.js';
import { disconnectAll } from './services/ssh.js';
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/servers.js';
import protocolRoutes from './routes/protocols.js';
import clientRoutes from './routes/clients.js';
import subscriptionRoutes from './routes/subscriptions.js';

// Логируем необработанные ошибки, но процесс не убиваем — единичный rejection
// в SSH-вызове не должен класть весь backend (другие сессии продолжают работать).
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.stack || reason);
});

const app = express();
const PORT = process.env.PORT || 3001;

// Доверяем первому proxy (nginx внутри docker network)
app.set('trust proxy', 1);

// CORS не нужен: фронт и API ходят через один nginx (same-origin).
// /sub/:slug потребляется не браузерами (Clash/FLClash) — CORS им безразличен.
app.use(helmet({
  // API возвращает только JSON/text — CSP применяется к HTML-документам, для нас бесполезна.
  contentSecurityPolicy: false,
  // HSTS включится автоматически только при NODE_ENV=production.
  hsts: process.env.NODE_ENV === 'production',
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
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
  console.error('[error]', req.method, req.originalUrl, '→', err.stack || err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`[startup] Amnezia Panel backend running on :${PORT}`);
});

// Graceful shutdown по SIGTERM (docker compose down) и SIGINT (Ctrl+C).
// Сбрасываем БД на диск, закрываем SSH-соединения, останавливаем HTTP-сервер.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining...`);
  const timer = setTimeout(() => {
    console.error('[shutdown] forced exit after 10s timeout');
    process.exit(1);
  }, 10000).unref();

  server.close(() => {
    try { flushSave(); } catch (e) { console.error('[shutdown] flushSave failed:', e.message); }
    try { disconnectAll(); } catch (e) { console.error('[shutdown] disconnectAll failed:', e.message); }
    clearTimeout(timer);
    console.log('[shutdown] done');
    process.exit(0);
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
