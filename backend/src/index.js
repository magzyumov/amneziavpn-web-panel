import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import { getDb } from './services/db.js';
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/servers.js';
import protocolRoutes from './routes/protocols.js';
import clientRoutes from './routes/clients.js';
import subscriptionRoutes from './routes/subscriptions.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

await getDb();

app.use('/api/auth', authRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/protocols', protocolRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/subscriptions', subscriptionRoutes);

// Публичный endpoint для подписок (без /api префикса)
app.use('/', subscriptionRoutes);

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Amnezia Panel backend running on :${PORT}`);
});
