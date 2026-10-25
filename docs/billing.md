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

Preços recorrentes padrão: Starter R$ 19, Pro R$ 49 e Business R$ 139, com um
primeiro mês promocional (Starter R$ 9,99, Pro R$ 15,99, Business R$ 29,90) no
estilo do concorrente: a landing mostra o 1º mês e, abaixo, o preço normal. O
desconto do 1º mês é um cupom de uso único (`amount_off`, `duration: once`) por
plano, criado por `pnpm stripe:setup` (grava `STRIPE_COUPON_<PLANO>`) e aplicado
no Checkout da assinatura; as renovações voltam ao preço normal. O PIX avulso
cobra o preço normal. Nenhum plano inclui API. Chaves de API, API pública e webhooks são o adicional
"+ API" (R$ 50,00/mês), que qualquer plano pago pode contratar e o Free não.
O direito existe apenas com plano pago vigente E adicional ACTIVE/TRIALING
dentro do período; adicional pago sem plano pago não libera nada. O limite de
requisições por minuto continua sendo o do plano.

O adicional é uma assinatura Stripe separada (um único item) no mesmo Customer:
o portal do cliente não altera assinaturas com vários produtos, e a troca de
plano é feita por ele. A contratação é POST /api/dashboard/billing/checkout com
{"addon":"API"} (OWNER/ADMIN, Idempotency-Key); o cancelamento acompanha o do
plano (abaixo) ou é feito sozinho no portal ("Gerenciar no portal"). Na reconciliação cada assinatura do Customer é
classificada pelos seus Prices (plano, adicional ou ambos).

## Gestão da assinatura na área do cliente

Em Configurações → Assinatura e na página Assinatura, OWNER/ADMIN gerenciam a
assinatura no cartão sem sair da UNO; MEMBER vê só o estado. Todas as rotas
abaixo exigem mesma origem e `Idempotency-Key`, valem só para a organização
selecionada e, depois da chamada à Stripe, reconciliam o Customer na hora
(`reconcileStripeCustomer`), sem esperar o webhook. O portal continua para
cartão, dados de cobrança, faturas e cancelamento só do adicional.

- **Troca de plano** — POST /api/dashboard/billing/plan `{planId}`: troca o
  Price do item do plano na mesma assinatura. Plano maior: a diferença
  proporcional é cobrada na hora (`proration_behavior: always_invoice`,
  `payment_behavior: error_if_incomplete`), então a cota maior nunca é usada a
  crédito. Plano menor: vale agora, sem crédito pelos dias restantes
  (`proration_behavior: none`) e desfaz um cancelamento agendado. Recusa o plano
  atual (409 `same_plan`) e assinatura inadimplente (409 `payment_pending`).
  O Price de destino é validado como no checkout. Sem assinatura no cartão a
  resposta é `{checkout:true}` e a tela abre o Checkout normal.
- **Cancelamento** — POST /api/dashboard/billing/cancel `{alsoAddon?}`:
  `cancel_at_period_end=true`; os direitos seguem até o fim do período. Por
  padrão (`alsoAddon` omitido ou `true`) o "+ API" também é agendado para
  cancelar, pois sem plano pago ele não concede nada. POST
  /api/dashboard/billing/resume `{alsoAddon?}` desfaz.
- **Reembolso de 7 dias** — GET/POST /api/dashboard/billing/refund. Direito de
  arrependimento (CDC, art. 49), automático: elegível quando a primeira fatura
  paga da assinatura do plano tem `status_transitions.paid_at` há no máximo
  7×24 h e a organização nunca usou esse reembolso. Estorna 100% de cada
  pagamento (PaymentIntent) das faturas do plano e do adicional pagas nessa
  janela (`refunds.create` com chave `uno-refund-<fatura>-<payment_intent>` e
  metadata `organizationId` + `uno_refund=7d`), encerra essas assinaturas na
  hora (`subscriptions.cancel`, sem crédito proporcional) e reconcilia: a
  organização volta ao Free. GET devolve `{eligible, reason, deadline, amountBrlCents, inProgress}`.
  **Um por organização**: `subscriptions.refund_started_at` é gravado antes de
  qualquer chamada à Stripe e `refunded_at` ao final (migração 0017).
  Assinar de novo não reabre o direito. Se a execução parar no meio, um novo
  POST conclui (mesmo fora da janela): pagamentos já estornados são pulados
  (`refunds.list` por PaymentIntent) e as chaves de idempotência evitam
  estorno duplo. Enquanto houver reembolso em andamento, checkout, troca e
  cancelamento devolvem 409 `refund_in_progress`. Cada reembolso concluído gera
  uma linha JSON `billing.refund.completed` no log (sem dados de pagamento).
  Crédito pré-pago por PIX ou indicação não é reembolsado nem cancelado por
  aqui: a tela só informa até quando ele vale.

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
