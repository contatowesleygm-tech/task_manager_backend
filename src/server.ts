import 'dotenv/config';
import { app } from './app';
import { pool } from './config/database';
import { startMarketRefresh } from './services/market/opportunities.service';

const port = Number(process.env.PORT ?? 3000);

async function start() {
  await pool.query('SELECT 1');
  console.log('Conexão com o PostgreSQL confirmada.');
  app.listen(port, () => {
    console.log(`Task Manager API disponível em http://localhost:${port}`);
  });
  startMarketRefresh();
}

start().catch((error) => {
  console.error(
    'Não foi possível iniciar a API. Verifique a configuração do banco e o PostgreSQL.',
    error
  );
  process.exit(1);
});
