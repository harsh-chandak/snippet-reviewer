import * as dotenv from 'dotenv';
dotenv.config();

import app from './app';
import db from './db/postgres';

const port = Number(process.env.PORT) || 4000;

async function start() {
  await db.authenticate();
  // Creates missing tables once at startup, for the models imported before this line.
  // Production would use migrations instead.
  await db.sync();
  app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start API:', err);
  process.exit(1);
});
