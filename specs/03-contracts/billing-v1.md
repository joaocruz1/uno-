---
id: CONTRACT-UNO-BILLING-001
status: approved
spec: SPEC-UNO-001
---

# Assinatura e direitos de uso

Plano efetivo vem do banco e estado vigente, nunca da confirmação no navegador.
É o maior entre a assinatura Stripe e um crédito pré-pago. Pela Stripe, somente
ACTIVE/TRIALING com início <= agora < fim permitem plano contratado;
sem período vigente usam FREE. Cancelamento
no fim mantém direitos até esse momento. INCOMPLETE/PAST_DUE/UNPAID/PAUSED/
CANCELED usam FREE mesmo com data futura. Não conceder excedentes automáticos.

Crédito pré-pago: dias de plano pago (compra avulsa por PIX ou recompensa de
indicação) gravados em subscriptions.prepaid_plan_id/prepaid_period_end, fonte
de direito ao lado da Stripe. Vale enquanto agora < prepaid_period_end. A
reconciliação da Stripe NÃO escreve essas colunas (coexiste com assinatura no
cartão). A cota usa o mês civil UTC quando o direito vem do pré-pago. Concessões
ficam em billing_grants, idempotentes por external_ref (id do pagamento PIX ou
chave do ciclo de indicação): somam dias sobre período vigente (max(agora, fim)
+ dias) e nunca rebaixam o plano no período. O "+ API" continua exigindo plano
pago cobrado pela Stripe; pré-pago não contrata o adicional nesta fase.
Limites e preços padrão seguem SPEC001 e podem ser configurados por ambiente;
valores inválidos falham explicitamente. Configuração pública contém apenas
preços e limites, nunca IDs privados ou credenciais.

Adicional de API: nenhum plano inclui API. Chaves, API pública e webhooks exigem
plano pago efetivo (regra acima) E adicional com estado ACTIVE/TRIALING e
agora < fim do período do adicional. Adicional pago sem plano pago vigente não
concede nada. O adicional é uma assinatura Stripe própria, de item único, no
mesmo Customer da organização; a assinatura do plano permanece de item único
para continuar gerenciável pelo portal. Preço padrão 5000 centavos/mês,
configurável por UNO_API_ADDON_PRICE_BRL_CENTS (inteiro positivo). O limite de
requisições continua sendo o do plano. A negação mantém o código plan_required.

POST dashboard billing/checkout exige OWNER/ADMIN, mesma origem, plano pago
permitido e chave idempotente. Server escolhe Price mensal BRL configurado,
valida recorrência/valor/moeda no Stripe, cria Customer associado à organização
e Checkout subscription. Persistir Customer e intenção de Checkout antes da
abertura; uma intenção aberta por organização reutiliza a sessão mesmo com
chaves diferentes, recuperando respostas perdidas. Concorrência usa
idempotência Stripe/lock por organização. Não criar segundo contrato pago
quando já existe assinatura gerenciável: direcionar ao portal.
O mesmo POST aceita exatamente um alvo: {planId} ou {addon:"API"}. O adicional
exige OWNER/ADMIN, plano pago efetivo e cobrado pela Stripe (409
paid_plan_required; plano concedido sem assinatura Stripe não contrata, pois a
reconciliação o rebaixaria), nenhum adicional
ainda vivo localmente ou no Stripe (409 addon_already_active; inadimplência se
resolve no portal) e Price do adicional configurado (503 addon_unavailable),
distinto dos Prices de plano e validado como os demais (ativo, BRL, mensal,
valor do catálogo). Usa o mesmo Customer, a mesma intenção/idempotência e
metadata organizationId + uno_addon=API na assinatura. Cancelamento do adicional
acompanha o do plano (alsoAddon) ou é feito sozinho no portal. STRIPE_PRICE_API_ADDON é opcional: sem ele a cobrança dos
planos funciona e o adicional apenas não é oferecido.
POST billing/portal exige OWNER/ADMIN/mesma origem, usa exclusivamente Customer
da organização, returnURL fixo.
GET billing inclui estado/plano/período/cancelamento e disponibilidade real,
e apiAddon {name, priceBrlCents, active, status, currentPeriodEnd, available,
inactiveWithoutPaidPlan}, management {changePlan, cancel, resume} (OWNER/ADMIN,
assinatura no cartão ACTIVE/TRIALING) e prepaid {planId, periodEnd} | null.

Gestão no app (OWNER/ADMIN, mesma origem, Idempotency-Key, escopo da
organização; MEMBER 403). Só a assinatura no cartão do próprio Customer, com o
id reconciliado localmente, é alterada; ao final reconcilia o Customer.
POST billing/plan {planId}: troca o Price do item do plano na mesma assinatura
(maior: always_invoice + error_if_incomplete, cobrado na hora; menor:
proration none, sem crédito) e limpa cancelamento agendado; Price de destino validado
como no checkout; plano atual → 409 same_plan; inadimplente → 409
payment_pending; sem assinatura no cartão → {checkout:true}.
POST billing/cancel {alsoAddon?=true}: cancel_at_period_end no plano e, por
padrão, no adicional; direitos até o fim do período. POST billing/resume
{alsoAddon?=true} desfaz. Sem assinatura → 409 no_card_subscription.
Reembolso de 7 dias (direito de arrependimento, CDC art. 49), automático e
único por organização. GET billing/refund → {eligible, reason
(no_card_subscription|no_paid_invoice|window_expired|already_refunded),
deadline, amountBrlCents, inProgress}. Janela: [paid_at da primeira fatura paga
da assinatura do plano, +7×24 h]. POST billing/refund estorna 100% de cada
PaymentIntent das faturas do plano e do adicional pagas na janela (chave
uno-refund-<fatura>-<payment_intent>, metadata organizationId e uno_refund=7d),
encerra essas assinaturas imediatamente e reconcilia (volta ao Free). Grava
subscriptions.refund_started_at antes da Stripe e refunded_at ao final;
refunded_at preenchido → 409 refund_already_used; inelegível → 409
refund_not_eligible. Reembolso iniciado e interrompido pode ser concluído por
novo POST mesmo fora da janela, pulando pagamentos já estornados; enquanto
isso checkout/troca/cancelamento → 409 refund_in_progress. Crédito pré-pago
(PIX/indicação) fica fora dessas ações.

POST api/stripe/webhook verifica assinatura sobre bytes originais limitados,
sem aceitar JSON reparsed. Eventos Stripe deduplicados por ID+hash. Eventos
checkout.session.completed/async_payment_succeeded, customer.subscription.*,
invoice.paid/payment_failed iniciam reconciliação da assinatura atual via API;
eventos fora de ordem não reaplicam snapshot antigo. Serializar por organização
a consulta Stripe e aplicação por lock distribuído/DB com fencing; uma consulta
vencida não aplica após consulta mais nova. Customer é fronteira de
propriedade; nunca confiar em metadata para mover assinatura entre organizações.
Aceitar resultado apenas para Price reconhecido com Customer/Subscription
corretos. Cada assinatura é classificada pelos seus Prices: Price de plano →
assinatura do plano; Price do adicional → adicional (id, estado e fim do
período próprios); assinatura só com o adicional nunca é plano; assinatura com
Price de plano e do adicional vale para ambos. Sem assinatura do adicional os
campos são limpos; cancelada fica CANCELED. Duplicidade de adicional não
bloqueia a reconciliação: prevalece a que concede acesso. Sem Price do
adicional configurado o estado gravado do adicional não é alterado. Customer sem associação local é ignorado, não associado por metadata.
Falha retorna erro para retry Stripe; reconciliação periódica recupera
eventos perdidos. Não logar payload, e-mail ou dados de pagamento.

Mudança de plano atualiza período/cota com lock. Reservas/confirmados já
registrados permanecem; novas reservas nunca permitem consumo acima do novo
limite. Limite contábil do registro pode ser max(limite efetivo, uso já aceito),
preservando a constraint; admissão e DTO usam limite efetivo do plano.
Downgrade com uso maior mantém integridade do contador e remaining=0,
sem apagar uso e sem cobrança adicional. Criações sempre revalidam limite
efetivo antes da reserva. API/chaves/webhooks perdem direito quando plano muda.
Períodos distintos preservam contabilidade anterior. Alteração de plano dentro
do período ativo nunca cria nova franquia nem zera contadores: manter o ID do
período; alinhar fim ao maior fim vigente/novo na primeira associação Stripe.
Ao fechar um período, novo início nunca antecede fim anterior (sem sobreposição);
usar período Stripe vigente ou fim do mês UTC em Free. Um período parcial de
transição continua sujeito ao limite integral, sem excedentes pagos.
Operações aceitas antes de downgrade continuam com reservas/retenção fixadas;
perda de plano só impede novas operações. Resolver direitos igualmente em
uploads, criação, reprocessamento, lotes, API e webhooks.

Tests: assinatura válida/inválida, ID duplicado/hash divergente, eventos fora de
ordem, relação Customer/organização, Price desconhecido, estados/períodos,
cancelamento, upgrade/downgrade, cota concorrente, troca de plano no app,
cancelamento/retomada com e sem adicional, reembolso de 7 dias (janela, único
por organização, adicional junto, retomada após falha parcial), MEMBER e
isolamento entre organizações, matriz de direitos do
adicional, regras do checkout do adicional e classificação na reconciliação. Provider sandbox real e
produção ficam gates externos quando faltam credenciais. Impostos requerem
configuração fiscal do operador; automatic_tax não é habilitado por hipótese.
