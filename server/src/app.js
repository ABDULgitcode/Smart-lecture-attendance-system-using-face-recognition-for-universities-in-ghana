import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import mongoose from 'mongoose';
import { config } from './config.js';
import { errorHandler } from './middleware/error.js';
import { faceHealth } from './services/faceClient.js';
import { authRouter } from './routes/auth.js';
import { catalogRouter } from './routes/catalog.js';
import { studentRouter } from './routes/students.js';
import { sessionRouter } from './routes/sessions.js';
import { insightRouter } from './routes/insights.js';
import { wrap } from './utils/http.js';

export const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/meta', (req, res) => {
  res.json({ universityName: config.universityName, policyVersion: config.policyVersion });
});

app.get('/api/health', wrap(async (req, res) => {
  const face = await faceHealth();
  res.json({ ok: true, mongo: mongoose.connection.readyState === 1, face });
}));

app.use('/api/auth', authRouter);
app.use('/api', catalogRouter);
app.use('/api', studentRouter);
app.use('/api', sessionRouter);
app.use('/api', insightRouter);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

function publicDirectory() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../public'),
    path.resolve(here, '../../public'),
    path.resolve(process.cwd(), 'public'),
    path.resolve(process.cwd(), '../public'),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) || candidates[0];
}

app.use(express.static(publicDirectory()));

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

app.use(errorHandler);
