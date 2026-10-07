# Cobrança e cota

O plano efetivo é calculado no servidor. Apenas assinaturas ACTIVE/TRIALING
com período vigente habilitam o plano pago. Cancelamento agendado preserva
direitos até o fim; inadimplência, pausa, cancelamento ou período expirado usam
Free. Operações já aceitas preservam reservas e retenção.

Configurar STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET e STRIPE_PRICE_STARTER/PRO/
BUSINESS no ambiente privado. Cada Price precisa estar ativo, em BRL, mensal,
com uma unidade por período e valor igual ao catálogo configurado. Não publicar
IDs/chaves nem habilitar automatic_tax sem configuração fiscal do operador.
Usar uma conta de testes separada; dados reais de pagamento não entram nos testes.

O endpoint de eventos é POST /api/stripe/webhook. A assinatura é verificada sobre
os bytes originais. Eventos repetidos são deduplicados, e a assinatura atual é
consultada no Stripe antes de aplicar direitos. A reconciliação periódica recupera
eventos perdidos; não confiar em querystrings de retorno do Checkout.

Preços e limites podem ser definidos por UNO_PLAN_<FREE|STARTER|PRO|BUSINESS>_
PRICE_BRL_CENTS, MONTHLY_LIMIT, MAX_FILE_MB, BATCH_LIMIT, RETENTION_DAYS e RATE_LIMIT.
Exemplo: UNO_PLAN_PRO_PRICE_BRL_CENTS=5900. Configuração inválida falha explicitamente;
os limites de segurança da engine e infraestrutura continuam aplicáveis.

Mudanças dentro de um período não zeram contadores. A capacidade contábil pode
acomodar uso já aceito após downgrade; novas admissões usam o limite efetivo.
remaining nunca fica negativo. Retentativas internas não cobram novamente;
reprocessamento deliberado cria outra conversão. Não há excedentes automáticos.

Validação no Stripe sandbox, delivery real de webhooks e portal configurado são
gates de provedor, separados dos testes locais com gateway injetado. Nunca marcar
cobrança real como verificada somente pelos mocks.
