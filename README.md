# Task Manager Backend

API REST em Node.js, TypeScript, Express e PostgreSQL para tarefas diárias com checklist e relatórios.

## Requisitos

- Node.js 20 ou superior
- Docker Compose (para iniciar o PostgreSQL local)

## Configuração

1. Instale as dependências:

   ```bash
   npm install
   ```

2. Inicie o PostgreSQL local:

   ```bash
   docker compose up -d db
   ```

   Aguarde o container ficar saudável antes de continuar:

   ```bash
   docker compose ps
   ```

3. Configure o `.env`. Se o arquivo ainda não existir, copie o exemplo:

   ```bash
   cp .env.example .env
   ```

   Se já existir, atualize nele apenas a `DATABASE_URL` para apontar ao PostgreSQL do Compose:

   ```text
   postgresql://task_manager:task_manager_dev@127.0.0.1:5432/task_manager
   ```

4. Crie as tabelas e funções da API:

   ```bash
   docker compose exec -T db psql -U task_manager -d task_manager < sql/schema.sql
   ```

5. Inicie a API:

   ```bash
   npm run dev
   ```

6. Verifique `http://localhost:3000/api/health`. A resposta inclui o estado da conexão com o banco; se o PostgreSQL estiver indisponível, a rota retorna HTTP 503.

Exemplo de resposta quando a conexão está funcionando:

```json
{
  "status": "ok",
  "service": "task-manager-api",
  "database": "connected"
}
```

O banco persiste em um volume Docker chamado `task_manager_postgres_data`. Para parar o PostgreSQL sem apagar os dados, execute `docker compose down`. Não remova o volume se quiser manter os dados locais.

Para usar uma instalação própria do PostgreSQL em vez do Compose, defina `DATABASE_URL` no `.env` com o usuário, senha, host, porta e banco corretos, e execute `sql/schema.sql` nesse banco. Como alternativa, configure `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD`; quando `DATABASE_URL` estiver definida, ela tem prioridade.

## Endpoints

### Assistente IA

- `POST /api/assistant/chat` — envia `message` e `history` para o assistente; exige sessão autenticada

Configure `OPENAI_API_KEY` no `.env` do backend. Opcionalmente, defina `OPENAI_MODEL` (padrão: `gpt-4.1-mini`). A chave nunca deve ser configurada no frontend.

### Materiais de estudo

- `GET /api/study-resources?area=Matemática&type=link&search=álgebra&page=1&limit=20` — pesquisa materiais do usuário autenticado
- `GET /api/study-resources/areas` — lista áreas e quantidade de materiais
- `GET /api/study-resources/:id` — consulta um material
- `POST /api/study-resources` — salva link, anotação, documento ou imagem por área
- `PATCH /api/study-resources/:id` — atualiza um material
- `DELETE /api/study-resources/:id` — remove um material

Tipos aceitos: `link`, `texto`, `documento`, `video`, `curso`, `livro`, `artigo`, `imagem` e `outro`. O cadastro precisa de `title`, `area`, `type` e pelo menos um entre `url` e `content`; para `imagem`, informe a URL da imagem em `url`. `tags` é opcional.

Exemplo de imagem: `{"title":"Diagrama de células","area":"Biologia","type":"imagem","url":"https://exemplo.com/celulas.png"}`.

### Acompanhamento de estudos de inglês

- `GET /api/english-study/summary?from=2026-10-01&to=2026-10-28` — resumo diário das sessões concluídas, meta e progresso de hoje (por padrão, últimos 7 dias)
- `GET /api/english-study/goal` — consulta a meta diária em minutos (padrão: 30)
- `PUT /api/english-study/goal` — define a meta com `{"daily_goal_minutes":45}`
- `GET /api/english-study/sessions?from=2026-10-01&to=2026-10-28&status=planejado&page=1&limit=20` — lista sessões planejadas, concluídas ou canceladas
- `POST /api/english-study/sessions` — planeja uma sessão ou registra um estudo concluído
- `PATCH /api/english-study/sessions/:id` — edita a sessão ou altera seu status para `concluido`/`cancelado`
- `DELETE /api/english-study/sessions/:id` — remove uma sessão

Cada sessão requer `title` e `study_date` (`YYYY-MM-DD`); aceita `topic`, `study_time` (`HH:MM`), `duration_minutes` (1 a 1440; padrão: 30), `status` (`planejado`, `concluido` ou `cancelado`), `material_url` e `content` (anotações ou conteúdo de até 50.000 caracteres). A meta diária é individual por usuário e o resumo considera apenas sessões concluídas. Para guardar vídeos e outros materiais, use a biblioteca existente com `area: "Inglês"`; o cronograma das sessões pode ser consultado e filtrado por data nesta API.

Antes do primeiro uso, aplique a migração `sql/migrations/20261028_create_english_study.sql`. Exemplo de sessão: `{"title":"Prática de listening","topic":"Conversação","study_date":"2026-10-28","study_time":"18:00","duration_minutes":30,"status":"planejado","material_url":"https://exemplo.com/video","content":"Anotar expressões novas"}`.

### Despesas

- `GET /api/expenses?type=compra&category=Mercado&month=2026-10&active=true&search=luz&page=1&limit=20` — lista despesas (`month` filtra só compras; fixas sempre aparecem)
- `GET /api/expenses/categories` — categorias usadas e quantidade de despesas
- `GET /api/expenses/summary?month=2026-10` — resumo do mês (fixas ativas + compras), comparação com o mês anterior, categoria com maior gasto, participação por categoria e gastos dia a dia
- `GET /api/expenses/:id` — consulta uma despesa
- `POST /api/expenses` — cadastra uma despesa
- `PATCH /api/expenses/:id` — atualiza uma despesa
- `DELETE /api/expenses/:id` — remove uma despesa

Campos: `name` e `amount` (maior que zero, em BRL) e `expense_type` (`compra` ou `fixa`) são obrigatórios; `category` (padrão `Outros`), `notes` e `is_active` (padrão `true`) são opcionais. Compras exigem `expense_date` (`YYYY-MM-DD`); fixas exigem `due_day` (1 a 31) e representam um valor mensal recorrente — use `is_active:false` para pausá-las. Aplique `sql/migrations/20261029_create_expenses.sql` antes do primeiro uso.

Exemplo de compra: `{"name":"Combustível","expense_type":"compra","category":"Transporte","amount":300,"expense_date":"2026-10-10"}`. Registre hotel e lanche da mesma forma, usando categorias como `Hospedagem` e `Alimentação`. O resumo retorna `fixed_total`, `purchases_total`, `total`, `comparison` (diferença e variação percentual; percentual `null` quando não há gastos no mês anterior), `top_category`, `by_category` (total, quantidade e percentual) e `daily_spending` (compras por dia, incluindo dias sem gastos; despesas fixas não entram nessa série).

### Dividendos

- `GET /api/dividends/types` — lista os tipos de investimento aceitos (rótulo, frequência padrão e se há cotação automática)
- `GET /api/dividends/projection?from=2026-11&months=12&cdi_rate=13.65` — projeta quanto você recebe por mês e considera renda fixa com percentual do CDI (padrão: mês atual, 12 meses; máximo 36; `cdi_rate` usa a taxa anual do CDI em %)
- `GET /api/dividends/portfolio` — total investido, valor atual, lucro/prejuízo e totais por tipo de ativo e por segmento de FII
- `POST /api/dividends/refresh-prices` — busca a cotação atual (Yahoo Finance, cache de 5 minutos) e grava em `current_price` dos ativos ativos com `auto_price:true` dos tipos `fii`, `fiagro`, `acao`, `bdr`, `etf` (B3, sufixo `.SA`), `acao_us` e `cripto`; devolve o resultado por ticker. Ao cadastrar um ativo sem `current_price`, a cotação já é buscada automaticamente quando o tipo tem cotação. Informar `current_price` manualmente desliga a atualização automática daquele ativo (envie `auto_price:true` para religar). Cada ativo traz `price_updated_at`. Tesouro, CDB, LCI/LCA, fundos, debêntures, previdência e renda fixa usam preço informado manualmente.
- `GET /api/dividends?asset_type=acao&active=true&search=PETR&page=1&limit=20` — lista os ativos cadastrados
- `GET /api/dividends/:id` — consulta um ativo
- `POST /api/dividends` — cadastra um ativo
- `PATCH /api/dividends/:id` — atualiza (por exemplo, quantidade de cotas ou provento)
- `DELETE /api/dividends/:id` — remove um ativo

Campos: `ticker` (único por usuário, salvo em maiúsculas; até 40 caracteres) e `quantity` são obrigatórios para ativos tradicionais; para renda fixa, `quantity` pode ficar em 1 e o valor real entra em `applied_amount`/`valor_aplicado`. `dividend_per_share` (provento por cota/ação, em BRL; padrão 0), `asset_type` (`fii`, `fiagro`, `acao`, `bdr`, `etf`, `fundo`, `tesouro`, `cdb`, `lci_lca`, `debenture`, `previdencia`, `cripto`, `acao_us`, `renda_fixa`, `outro`; padrão `fii`), `fii_segment` (`papel`, `tijolo` ou `hibrido`; só para FII/Fiagro; `null` limpa; também filtra a listagem com `?fii_segment=papel`), `average_price` (preço médio pago, BRL; padrão 0) e `current_price` (preço atual; `null` usa o preço médio). Cada ativo retorna `invested_amount` (quantidade × preço médio), `current_value` (quantidade × preço atual) e `profit_loss`. A carteira ativa entra no `total_patrimony` de `/api/finances/summary` (campos `investment_portfolio_invested_brl`, `investment_portfolio_value_brl` e `investment_portfolio_profit_loss_brl`); se você também lança os mesmos ativos como conta de investimento, remova-os de uma das duas para não contar em dobro. `frequency` (`mensal`, `trimestral`, `semestral`, `anual`; se omitida, usa o padrão do tipo: mensal para FII/renda fixa, trimestral para ação/BDR/ETF, semestral para Tesouro/debênture), `reference_month` (1 a 12; mês de um pagamento, usado para definir os meses de frequências não mensais), `payment_day` (1 a 31; padrão 15), `name`, `notes` e `is_active`. Para renda fixa, use também `cdi_percent` (ex.: `120` para 120% do CDI), `applied_amount`/`valor_aplicado` (valor investido em BRL) e `investment_date`/`data_investimento` (data do aporte em `YYYY-MM-DD`). A projeção considera a taxa anual do CDI informada em `cdi_rate`; sem esse parâmetro, ela usa `13.65` como padrão. Aplique `sql/migrations/20261029_create_dividend_holdings.sql` antes do primeiro uso; se ela já tinha sido aplicada, rode também `20261029_expand_dividend_asset_types.sql`, `20261029_add_dividend_fii_segment.sql`, `20261029_add_dividend_prices.sql`, `20261029_add_dividend_auto_price.sql`, `20261031_expand_dividend_investment_types.sql` e `20261104_add_dividend_fixed_income_projection.sql`.

Exemplos: `{"ticker":"PETR4","asset_type":"acao","quantity":100,"average_price":38.5,"dividend_per_share":0.9}` (frequência trimestral automática); `{"ticker":"TESOURO SELIC 2029","asset_type":"tesouro","quantity":3.2,"average_price":15000,"current_price":15210,"dividend_per_share":0}`; `{"ticker":"BTC","asset_type":"cripto","quantity":0.05,"average_price":350000}`; `{"ticker":"NUBANK-120","asset_type":"renda_fixa","quantity":1,"applied_amount":10000,"cdi_percent":120,"investment_date":"2026-11-04","payment_day":5}` (renda fixa baseada em CDI, calculada automaticamente na projeção com `cdi_rate=13.65`).

### Finanças

- `GET /api/finances/summary` — separa ativos e passivos e calcula o patrimônio líquido em BRL
- `GET /api/finances/accounts` — lista bancos, contas, investimentos e dinheiro cadastrados
- `POST /api/finances/accounts` — cadastra uma conta ou valor patrimonial
- `PATCH /api/finances/accounts/:id` — atualiza os dados ou saldo de uma conta
- `DELETE /api/finances/accounts/:id` — remove uma conta
- `GET /api/finances/assets` — lista carros, motos, imóveis e outros bens do usuário
- `POST /api/finances/assets` — cadastra um bem com valor estimado, dívida e situação de aluguel/financiamento
- `PATCH /api/finances/assets/:id` — atualiza um bem
- `DELETE /api/finances/assets/:id` — remove um bem
- `GET /api/finances/liabilities` — lista dívidas e obrigações do usuário
- `POST /api/finances/liabilities` — cadastra financiamento, cartão, empréstimo, aluguel ou conta
- `PATCH /api/finances/liabilities/:id` — atualiza um passivo
- `DELETE /api/finances/liabilities/:id` — remove um passivo

Exemplo de conta: `{"institution":"Banco do Brasil","account_name":"Conta principal","account_type":"conta_corrente","balance":2500.75,"currency":"BRL"}`. `currency` aceita `BRL` (padrão) ou `USD`. Contas em dólar retornam `balance_brl`; o resumo informa `brl_total`, `usd_total`, `usd_to_brl_rate` e `exchange_rate_date`, e `total_patrimony` é convertido para reais. A cotação diária mais recente vem da Frankfurter e fica em cache por uma hora. Tipos: `conta_corrente`, `poupanca`, `investimento`, `dinheiro` e `outro`. Valores negativos podem representar saldo devedor e reduzem o patrimônio total.

Exemplo de bem: `{"name":"Carro","asset_type":"carro","estimated_value":65000,"currency":"BRL","ownership_status":"financiado","include_in_patrimony":true}`. Tipos aceitos: `carro`, `moto`, `imovel` e `outro`; situações: `proprio`, `financiado`, `alugado`, `alugado_para_terceiros` e `outro`. Informe `monthly_rent` para acompanhar aluguel recebido. `include_in_patrimony:false` exclui um bem do cálculo. Bens em USD também retornam valores convertidos para BRL.

Exemplo de passivo: `{"name":"Financiamento do carro","liability_type":"financiamento","original_amount":80000,"outstanding_balance":42000,"monthly_payment":1500,"currency":"BRL","due_date":"2028-10-24"}`. Tipos: `financiamento`, `cartao_credito`, `emprestimo`, `aluguel`, `conta` e `outro`. O patrimônio líquido é calculado como saldos das contas + ativos − saldo devedor dos passivos. O resumo também informa `assets_total_brl`, `liabilities_total_brl` e `monthly_liability_payments_brl`.

### Autenticação

- `POST /api/auth/register` — cria usuário, assinatura e pagamento pendente
- `POST /api/auth/login` — inicia uma sessão e grava o cookie HttpOnly `task_manager_session`
- `GET /api/auth/me` — retorna o usuário da sessão atual
- `POST /api/auth/logout` — encerra a sessão atual

Cadastro exige `name`, `email`, `password` (mín. 8), `plan` (`monthly` | `annual`) e `payment_method` (`pix` | `card`). Com `card`, envie também `card: { holder_name, number, exp_month, exp_year, cvv }`. O backend **não grava** número nem CVV — só bandeira, últimos 4 dígitos e nome. A cobrança real fica para o gateway (Mercado Pago/Stripe).

Exemplo Pix:
```json
{"name":"Wesley","email":"wesley@email.com","password":"senha1234","plan":"monthly","payment_method":"pix"}
```

Exemplo cartão:
```json
{"name":"Wesley","email":"wesley@email.com","password":"senha1234","plan":"annual","payment_method":"card","card":{"holder_name":"WESLEY SILVA","number":"4111111111111111","exp_month":12,"exp_year":30,"cvv":"123"}}
```

Resposta `201`: `{ data: { user, subscription, payment, next_step } }` (`next_step`: `await_pix_gateway` ou `await_card_gateway`).

### Assinaturas e pagamentos

- `GET /api/subscriptions/plans` — planos, preços e métodos (`pix`, `card`) — público
- `GET /api/subscriptions/me` — assinatura atual + último pagamento (auth)
- `GET /api/subscriptions/payments/:id` — consulta um pagamento (auth)

Preços padrão: mensal `29.90`, anual `299.90` (BRL). Sobrescreva com `SUBSCRIPTION_PRICE_MONTHLY` e `SUBSCRIPTION_PRICE_ANNUAL`. Aplique `sql/migrations/20261031_create_subscriptions_and_payments.sql`.

O frontend deve enviar `credentials: "include"` nas requisições de login, sessão e logout.
As rotas de tarefas, histórico, relatórios, objetivos, metas e agenda exigem uma sessão válida e filtram os dados pelo `userId` da sessão.

- `GET /api/health` — status da API e conexão com o PostgreSQL (`200` conectado; `503` indisponível)
- `GET /api/tasks?page=1&limit=5` — lista tarefas com paginação (padrão: página 1, 5 por página; máximo: 100)
- `POST /api/tasks` — cria tarefa com checklist, prioridade e frequência
- `PATCH /api/tasks/:id` — edita os dados da tarefa e o checklist
- `PATCH /api/tasks/:id/activate` — ativa ou reativa uma tarefa
- `PATCH /api/tasks/:id/deactivate` — desativa tarefa sem apagar histórico
- `DELETE /api/tasks/:id` — exclui permanentemente a tarefa, o checklist e o histórico diário
- `GET /api/daily` — tarefas do dia; aceita `?date=YYYY-MM-DD`
- `GET /api/daily/history?date=YYYY-MM-DD&page=1&limit=10` — histórico diário separado por data (padrão: 10 dias por página)
- `GET /api/daily/history/:date` — consulta individual dos checks e do progresso de uma data
- `GET /api/daily/history/week?page=1&limit=10&date=YYYY-MM-DD` — histórico agrupado por semana; sem `date`, lista semanas anteriores
- `GET /api/daily/history/month?page=1&limit=10&date=YYYY-MM-DD` — histórico agrupado por mês; sem `date`, lista meses anteriores
- `PATCH /api/daily/items/:id` — conclui ou reabre um item diário; o ID é o `id` do item retornado por `GET /api/daily`
- `GET /api/goals` — lista objetivos e etapas de ação
- `GET /api/goals/:id` — consulta um objetivo e suas etapas individualmente
- `POST /api/goals` — cria objetivo com título, descrição, prazo e etapas
- `PATCH /api/goals/:id` — atualiza título, descrição ou prazo do objetivo
- `DELETE /api/goals/:id` — exclui objetivo e suas etapas
- `POST /api/goals/:id/steps` — adiciona uma etapa ao objetivo
- `PATCH /api/goals/:id/steps/:stepId` — conclui ou reabre uma etapa
- `DELETE /api/goals/:id/steps/:stepId` — remove uma etapa
- `GET /api/objectives` — lista objetivos com etapas
- `GET /api/objectives/:id` — consulta um objetivo com etapas
- `POST /api/objectives` — cria objetivo com `title`, `description`, `target_date`, `status` opcional e `steps` opcionais
- `PATCH /api/objectives/:id` — atualiza `title`, `description`, `target_date` ou `status`
- `DELETE /api/objectives/:id` — exclui objetivo e etapas vinculadas
- `POST /api/objectives/:id/steps` — adiciona etapa ao objetivo
- `PATCH /api/objectives/:id/steps/:stepId` — atualiza título, status ou ordem da etapa
- `DELETE /api/objectives/:id/steps/:stepId` — exclui uma etapa
- `GET /api/activity?page=1&limit=20&date=YYYY-MM-DD` — consulta atividades; também aceita `from`, `to` ou `event_type` para filtrar
- `GET /api/activity/:id` — consulta uma atividade individual do próprio usuário
- `GET /api/activity/summary` — retorna totais de checks, etapas e metas/objetivos concluídos
- `GET /api/schedule?page=1&limit=20` — lista todos os agendamentos cadastrados
- `GET /api/schedule?date=YYYY-MM-DD` — consulta agendamentos de uma data específica, incluindo aniversários recorrentes
- `GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&limit=20` — lista ocorrências em um intervalo de datas
- `GET /api/schedule/alerts?page=1&limit=20` — lista lembretes vencidos e eventos pendentes nas próximas 24 horas
- `POST /api/schedule` — cria lembrete, atividade ou aniversário
- `PATCH /api/schedule/:id` — atualiza um agendamento
- `DELETE /api/schedule/:id` — exclui um agendamento
- `GET /api/reports?period=week` — relatório semanal
- `GET /api/reports?period=month` — relatório mensal
- `GET /api/reports?period=year` — relatório anual
- Os relatórios aceitam `&date=YYYY-MM-DD` para selecionar o período que contém essa data.

Exemplo de listagem paginada:

```text
GET http://localhost:3000/api/tasks?page=2&limit=20
```

A resposta contém `data` com as tarefas e `pagination` com `page`, `limit`,
`total`, `totalPages`, `hasNextPage` e `hasPreviousPage`. Os parâmetros devem
ser inteiros positivos; `limit` não pode ser maior que 100.

Para bancos criados antes da inclusão do status de tarefa, execute a migração
`sql/migrations/20261022_add_task_activation.sql`.
Execute as migrações nesta ordem para preparar as colunas utilizadas pelas rotas:

1. `sql/migrations/20261022_add_task_activation.sql`
2. `sql/migrations/20261022_add_task_frequency.sql`
3. `sql/migrations/20261022_add_task_priority.sql`
4. `sql/migrations/20261022_create_life_goals.sql` (necessária para as rotas de objetivos)
5. `sql/migrations/20261022_create_objectives.sql` (necessária para as rotas `/api/objectives`)
6. `sql/migrations/20261023_create_schedule_events.sql` (necessária para `/api/schedule`)
7. `sql/migrations/20261024_create_users_and_sessions.sql` (necessária para autenticação e objetivos por usuário)
8. `sql/migrations/20261024_add_user_ownership.sql` (necessária para separar tarefas, objetivos, agenda e relatórios por usuário)
9. `sql/migrations/20261024_create_study_resources.sql` (necessária para a biblioteca de materiais de estudo)
10. `sql/migrations/20261024_create_financial_accounts.sql` (necessária para a organização financeira e o cálculo de patrimônio)
11. `sql/migrations/20261024_add_financial_account_currency.sql` (necessária para contas em BRL e USD)
12. `sql/migrations/20261024_create_activity_events.sql` (necessária para o monitoramento de atividades e notificações)
13. `sql/migrations/20261024_create_financial_assets.sql` (necessária para o cadastro de bens patrimoniais)
14. `sql/migrations/20261024_create_financial_liabilities.sql` (necessária para separar dívidas e obrigações dos ativos)
15. `sql/migrations/20261024_add_objective_step_activity.sql` (necessária para registrar conclusão de etapas de objetivos no histórico)
16. `sql/migrations/20261031_create_subscriptions_and_payments.sql` (necessária para planos e método de pagamento no cadastro)

As frequências aceitas são `dia`, `diaria`, `semana`, `semanal`, `mes` e `mensal`.

### Exemplo de criação de objetivo

```http
POST /api/objectives
Content-Type: application/json
```

```json
{
  "title": "Concluir curso",
  "description": "Finalizar o curso até o prazo",
  "target_date": "2026-12-31",
  "status": "em_andamento",
  "steps": [
    { "title": "Assistir às aulas", "status": "concluido", "step_order": 1 },
    { "title": "Entregar o projeto", "step_order": 2 }
  ]
}
```

Status de objetivo: `pendente`, `em_andamento` ou `concluido`.
Status de etapa: `pendente` ou `concluido`. Ao omitir status, o banco/API usa
`pendente`; `step_order` das etapas enviadas é numerado automaticamente quando omitido.

### Exemplo de agendamento

```http
POST /api/schedule
Content-Type: application/json
```

```json
{
  "title": "Aniversário da Ana",
  "description": "Comprar um presente",
  "type": "aniversario",
  "event_date": "1995-05-18",
  "event_time": null,
  "reminder_at": null,
  "status": "pendente"
}
```

Tipos aceitos: `lembrete`, `atividade` e `aniversario`. Status: `pendente`,
`concluido` ou `cancelado`. Aniversários repetem anualmente por padrão; os
demais tipos não. Para listar ocorrências, use `GET /api/schedule?from=2026-05-01&to=2026-05-31`.
Sem `date`, `from` ou `to`, a rota lista todos os registros cadastrados. Com
`date`, retorna apenas os eventos daquele dia e aniversários recorrentes nessa
data. `from` e `to` permitem consultar um intervalo; se um dos limites for
omitido, o outro limite usa hoje ou 30 dias de intervalo. Não combine `date`
com `from`/`to`. O parâmetro `reminder_at` guarda a data/hora do lembrete em
ISO 8601 com fuso, mas esta API ainda não envia notificações automaticamente.
Use `GET /api/schedule/alerts` para exibir os alertas na aplicação. A rota inclui
eventos pendentes cujo lembrete já chegou e eventos com ocorrência nas próximas
24 horas; não envia notificações por e-mail ou push.

## Exemplo de criação

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Estudar programação",
    "description": "Rotina de estudo",
    "priority": "medium",
    "frequencia": "semana",
    "start_date": "2026-10-22",
    "end_date": null,
    "items": ["Estudar React", "Praticar exercícios", "Revisar conteúdo"]
  }'
```

## Exemplo de edição

Envie título e checklist, com os demais campos opcionais:

```bash
curl -X PATCH http://localhost:3000/api/tasks/1 \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Estudar programação avançada",
    "description": "Atualizado para incluir projetos práticos",
    "start_date": "2026-10-22",
    "end_date": "2026-12-31",
    "priority": "high",
    "frequencia": "semana",
    "items": ["Estudar TypeScript", "Criar um projeto", "Revisar conteúdo"]
  }'
```

Os itens existentes são atualizados pela ordem e novos itens são adicionados.
Itens removidos também têm seus registros diários apagados permanentemente.
A prioridade aceita `low`, `medium` ou `high`; se omitida na criação, será `medium`.
A frequência aceita `dia`, `diaria`, `semana`, `semanal`, `mes` ou `mensal`; se omitida na criação, será `diaria`.
Ela é armazenada como informação da tarefa e não altera quais dias aparecem no calendário.

### Campos gravados no banco

O endpoint `POST /api/tasks` grava uma linha em `tasks`:

| Campo recebido | Coluna em `tasks` | Comportamento |
|---|---|---|
| `title` | `title` | Obrigatório; texto da tarefa |
| `description` | `description` | Texto ou `NULL` |
| `start_date` | `start_date` | Data; usa a data atual quando omitida |
| `end_date` | `end_date` | Data ou `NULL` |
| `priority` | `priority` | `low`, `medium` ou `high`; padrão `medium` |
| `frequencia` | `frequencia` | Um dos valores aceitos; padrão `diaria` |
| — | `is_active` | Inicializado pelo padrão do banco como `TRUE` |
| — | `created_at`, `updated_at` | Inicializados pelo banco |

Cada texto dentro de `items` cria uma linha em `task_items`, ligada por `task_id`,
com `title` e `sort_order` começando em zero. Ao editar, itens removidos e seus
registros relacionados em `task_daily_records` são excluídos permanentemente.

## Exemplo para marcar item

Use o `id` do item retornado em `items` por `GET /api/daily`:

```bash
curl -X PATCH http://localhost:3000/api/daily/items/1 \
  -H "Content-Type: application/json" \
  -d '{"is_completed": true}'
```

## Observações

- A primeira consulta do dia cria os registros diários que faltarem; o endpoint `GET /api/daily` faz isso.
- Cada data possui seus próprios registros de checklist: no novo dia, os itens começam pendentes e os dias anteriores permanecem no histórico.
- `GET /api/daily/history` lista os dias anteriores ao dia atual; use `GET /api/daily?date=YYYY-MM-DD` para abrir os detalhes de uma data específica.
- `/api/daily/history` retorna uma linha por data; as rotas `/week` e `/month` retornam uma linha agregada por semana ou mês, respectivamente. Use `date` para filtrar o período correspondente; semanas começam na segunda-feira. Datas sem registros não são criadas retroativamente.
- O dia atual usa `CURRENT_DATE` do PostgreSQL; configure o fuso horário do banco para determinar a hora local em que o novo dia começa.
- A data padrão da aplicação usa a data do servidor. Para produção, defina o fuso horário do servidor e do PostgreSQL de acordo com a região operacional.
- Esta versão ainda não inclui autenticação nem separação de dados por usuário; adicione isso antes de disponibilizar publicamente.
