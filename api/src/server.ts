import './loadEnv';
import app from './app';
import db from './db/postgres';
import { migrator } from './db/migrator';
import './model/schema';
import { reviewService } from './service/reviewService';

const port = Number(process.env.PORT) || 4000;

async function start() {
  await db.authenticate();
  // Applies any migrations that haven't run yet, so a fresh database gets its tables.
  await migrator.up();

  const interrupted = await reviewService.failInterrupted();
  if (interrupted) console.warn(`Marked ${interrupted} interrupted review(s) as failed`);

  app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start API:', err);
  process.exit(1);
});
