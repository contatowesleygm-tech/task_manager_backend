import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const databaseHost = process.env.DB_HOST;
const databaseName = process.env.DB_NAME;
const databaseUser = process.env.DB_USER;
const databasePassword = process.env.DB_PASSWORD;
const databasePort = Number(process.env.DB_PORT ?? 5432);
const hasSeparateDatabaseConfig = [
  databaseHost,
  databaseName,
  databaseUser,
  databasePassword,
].some(Boolean);

if (!databaseUrl && !hasSeparateDatabaseConfig) {
  throw new Error(
    'Configure DATABASE_URL ou DB_HOST, DB_NAME, DB_USER e DB_PASSWORD (DB_PORT é opcional).'
  );
}

if (
  !databaseUrl &&
  (!databaseHost || !databaseName || !databaseUser || !databasePassword)
) {
  throw new Error(
    'A configuração separada exige DB_HOST, DB_NAME, DB_USER e DB_PASSWORD. DB_PORT é opcional e usa 5432 por padrão.'
  );
}

if (
  !databaseUrl &&
  (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65535)
) {
  throw new Error('DB_PORT deve ser um número inteiro entre 1 e 65535.');
}

export const pool = new Pool({
  ...(databaseUrl
    ? { connectionString: databaseUrl }
    : {
        host: databaseHost,
        port: databasePort,
        database: databaseName,
        user: databaseUser,
        password: databasePassword,
      }),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (error) => {
  console.error('Erro inesperado no pool PostgreSQL:', error);
});
