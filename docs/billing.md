# Cobrança e cota

O plano efetivo é calculado no servidor, como o **maior** entre duas fontes:
a assinatura Stripe e um crédito pré-pago. Pela Stripe, apenas ACTIVE/TRIALING
com período vigente habilitam o plano pago. Cancelamento agendado preserva
direitos até o fim; inadimplência, pausa, cancelamento ou período expirado usam
Free. Operações já aceitas preservam reservas e retenção.

Crédito pré-pago (PIX avulso ou indicação): dias de um plano pago gravados em
`subscriptions.prepaid_plan_id`/`prepaid_period_end`, independentes da Stripe. A
reconciliação da Stripe nunca escreve essas colunas, então o pré-pago coexiste
com uma assinatura no cartão (vale o plano de maior tier). Enquanto o período
pré-pago não vence, o plano vale; a cota usa o mês civil UTC quando a fonte é o
pré-pago. As concessões ficam na tabela `billing_grants`, idempotentes por
`external_ref` (o id do pagamento PIX ou a chave do ciclo de indicação), somando
dias sobre um período ainda vigente e nunca rebaixando o plano no período.

Preços mensais padrão: Starter R$ 9,99, Pro R$ 15,99 e Business R$ 29,90.
Nenhum plano inclui API. Chaves de API, API pública e webhooks são o adicional
"+ API" (R$ 50,00/mês), que qualquer plano pago pode contratar e o Free não.
O direito existe apenas com plano pago vigente E adicional ACTIVE/TRIALING
dentro do período; adicional pago sem plano pago não libera nada. O limite de
requisições por minuto continua sendo o do plano.

O adicional é uma assinatura Stripe separada (um único item) no mesmo Customer:
o portal do cliente não altera assinaturas com vários produtos, e a troca de
plano é feita por ele. A contratação é POST /api/dashboard/billing/checkout com
{"addon":"API"} (OWNER/ADMIN, Idempotency-Key); o cancelamento é feito no
portal ("Gerenciar assinatura"). Na reconciliação cada assinatura do Customer é
classificada pelos seus Prices (plano, adicional ou ambos).

Configurar STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET e STRIPE_PRICE_STARTER/PRO/
BUSINESS no ambiente privado. STRIPE_PRICE_API_ADDON é opcional: sem ele os
planos são vendidos normalmente e o adicional não é oferecido.
`pnpm stripe:setup <arquivo .env>` cria os três planos e o produto "UNO API",
grava os quatro IDs e arquiva os Prices ativos anteriores desses produtos.
Assinaturas existentes em um Price arquivado continuam sendo cobradas pelo
Stripe, mas a reconciliação só reconhece os Prices configurados: migre esses
clientes antes de trocar os IDs em produção. Cada Price precisa estar ativo, em BRL, mensal,
com uma unidade por período e valor igual ao catálogo configurado. Não publicar
IDs/chaves nem habilitar automatic_tax sem configuração fiscal do operador.
Usar uma conta de testes separada; dados reais de pagamento não entram nos testes.

O endpoint de eventos é POST /api/stripe/webhook. A assinatura é verificada sobre
os bytes originais. Eventos repetidos são deduplicados, e a assinatura atual é
consultada no Stripe antes de aplicar direitos. A reconciliação periódica recupera
eventos perdidos; não confiar em querystrings de retorno do Checkout.

Preços e limites podem ser definidos por UNO_PLAN_<FREE|STARTER|PRO|BUSINESS>_
PRICE_BRL_CENTS, MONTHLY_LIMIT, MAX_FILE_MB, BATCH_LIMIT, RETENTION_DAYS e RATE_LIMIT.
Exemplo: UNO_PLAN_PRO_PRICE_BRL_CENTS=1599. O preço do adicional é
UNO_API_ADDON_PRICE_BRL_CENTS (padrão 5000). Configuração inválida falha explicitamente;
os limites de segurança da engine e infraestrutura continuam aplicáveis.

Mudanças dentro de um período não zeram contadores. A capacidade contábil pode
acomodar uso já aceito após downgrade; novas admissões usam o limite efetivo.
remaining nunca fica negativo. Retentativas internas não cobram novamente;
reprocessamento deliberado cria outra conversão. Não há excedentes automáticos.

Validação no Stripe sandbox, delivery real de webhooks e portal configurado são
gates de provedor, separados dos testes locais com gateway injetado. Nunca marcar
cobrança real como verificada somente pelos mocks.
