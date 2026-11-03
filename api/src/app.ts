import express from 'express';
import cors from 'cors';
import { route } from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: process.env.WEB_ORIGIN || 'http://localhost:3000',
  }),
);

app.use('/api', route);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
