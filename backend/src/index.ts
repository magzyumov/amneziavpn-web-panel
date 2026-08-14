import 'express-async-errors';
import { validateEnv } from './services/env.js';
validateEnv();

import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { getDb, flushSave } from './services/db.js';
import { initEncryption } from './services/crypto.js';
import { csrfMiddleware } from './middleware/auth.js';
import { auditMiddleware } from './middleware/audit.js';
import { disconnectAll } from './services/ssh.js';
import { startStatsWorker, stopStatsWorker } from './services/statsWorker.js';
import { logger } from './services/logger.js';
import { isUserError } from './services/errors.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import dashboardRoutes from './routes/dashboard.js';
import auditRoutes from './routes/audit.js';
import serverRoutes from './routes/servers.js';
import protocolRoutes from './routes/protocols.js';
import clientRoutes from './routes/clients.js';
import subscriptionRoutes from './routes/subscriptions.js';
import diskRoutes from './routes/disk.js';

// Логируем необработанные ошибки, но процесс не убиваем — единичный rejection
// в SSH-вызове не должен класть весь backend (другие сессии продолжают работать).
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Доверяем первому proxy (nginx внутри docker network)
app.set('trust proxy', 1);

// CORS не нужен: фронт и API ходят через один nginx (same-origin).
// /sub/:slug потребляется не браузерами (Clash/FLClash) — CORS им безразличен.
//
// Backend отдаёт только JSON и текстовые YAML — никаких HTML/JS/CSS,
// поэтому CSP с default-src 'none' максимально жёсткая: даже если по
// ошибке route вернёт HTML, ничего не выполнится. HTML фронта отдаёт
// nginx со своим CSP (frontend/nginx.conf).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  hsts: process.env.NODE_ENV === 'production',
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use('/api', csrfMiddleware);
// После CSRF: запрос, отбитый на CSRF, до действия не доходит, и в журнале
// действий ему делать нечего.
app.use('/api', auditMiddleware);

logger.info('Initializing encryption...');
try {
  initEncryption();
  logger.info('Encryption OK');
} catch (err) {
  logger.fatal({ err }, 'Encryption init FAILED');
  process.exit(1);
}

logger.info('Initializing database...');
try {
  await getDb();
  logger.info('Database OK');
} catch (err) {
  logger.fatal({ err }, 'Database init FAILED');
  process.exit(1);
}

// Без авторизации и CSRF (csrfMiddleware пропускает GET).
// Используется docker compose healthcheck'ом и внешним мониторингом.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth',          authRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/audit',         auditRoutes);
app.use('/api/servers',       serverRoutes);
app.use('/api/protocols',     protocolRoutes);
app.use('/api/clients',       clientRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/disk',          diskRoutes);

// Публичный endpoint для подписок (без /api префикса)
app.use('/', subscriptionRoutes);

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  // UserError несёт текст, написанный для пользователя, — отдаём как есть.
  // Всё остальное может содержать детали реализации, поэтому обезличиваем.
  if (isUserError(err)) {
    logger.warn({ err: err.message, method: req.method, url: req.originalUrl }, 'User error');
    return res.status(err.status).json({ error: err.message });
  }
  logger.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

const server = app.listen(PORT, () => {
  logger.info(`Amnezia Panel backend running on :${PORT}`);
  startStatsWorker();
});

// Graceful shutdown по SIGTERM (docker compose down) и SIGINT (Ctrl+C).
let shuttingDown = false;
function gracefulShutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, draining...`);
  const timer = setTimeout(() => {
    logger.error('Forced exit after 10s timeout');
    process.exit(1);
  }, 10000).unref();

  server.close(() => {
    try { stopStatsWorker(); } catch (e) { logger.error({ err: e }, 'stopStatsWorker failed'); }
    try { flushSave(); } catch (e) { logger.error({ err: e }, 'flushSave failed'); }
    try { disconnectAll(); } catch (e) { logger.error({ err: e }, 'disconnectAll failed'); }
    clearTimeout(timer);
    logger.info('shutdown done');
    process.exit(0);
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
