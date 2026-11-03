import path from 'path';
import * as dotenv from 'dotenv';

// One .env at the repo root serves the API and docker-compose.
// Values already set in the environment (e.g. by docker-compose) win.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
