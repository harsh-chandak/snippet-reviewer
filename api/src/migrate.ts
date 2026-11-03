// Command line for migrations: `npm run migrate` (up), `npm run migrate:down`, `npm run migrate -- pending`.
import './loadEnv';
import { migrator } from './db/migrator';

migrator.runAsCLI();
