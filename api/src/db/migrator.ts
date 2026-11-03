import path from 'path';
import { SequelizeStorage, Umzug } from 'umzug';
import db from './postgres';

// Migrations live in src/migrations and run in file-name order.
// Which ones have run is recorded in the SequelizeMeta table.
export const migrator = new Umzug({
  migrations: {
    // .ts under ts-node in development, .js once compiled to dist/
    glob: ['migrations/*.{ts,js}', { cwd: path.join(__dirname, '..'), ignore: ['**/*.d.ts'] }],
  },
  context: db.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize: db }),
  logger: console,
});

export type Migration = typeof migrator._types.migration;
