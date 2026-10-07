---
id: CONTRACT-UNO-BILLING-001
status: approved
spec: SPEC-UNO-001
---

# Assinatura e direitos de uso

Plano efetivo vem do banco e estado vigente, nunca da confirmação no navegador.
Somente ACTIVE/TRIALING com início <= agora < fim permitem plano contratado;
sem período vigente usam FREE. Cancelamento
no fim mantém direitos até esse momento. INCOMPLETE/PAST_DUE/UNPAID/PAUSED/
CANCELED usam FREE mesmo com data futura. Não conceder excedentes automáticos.
Limites e preços padrão seguem SPEC001 e podem ser configurados por ambiente;
valores inválidos falham explicitamente. Configuração pública contém apenas
preços e limites, nunca IDs privados ou credenciais.

POST dashboard billing/checkout exige OWNER/ADMIN, mesma origem, plano pago
permitido e chave idempotente. Server escolhe Price mensal BRL configurado,
valida recorrência/valor/moeda no Stripe, cria Customer associado à organização
e Checkout subscription. Persistir Customer e intenção de Checkout antes da
abertura; uma intenção aberta por organização reutiliza a sessão mesmo com
chaves diferentes, recuperando respostas perdidas. Concorrência usa
idempotência Stripe/lock por organização. Não criar segundo contrato pago
quando já existe assinatura gerenciável: direcionar ao portal.
POST billing/portal exige OWNER/ADMIN/mesma origem, usa exclusivamente Customer
da organização, returnURL fixo.
GET billing inclui estado/plano/período/cancelamento e disponibilidade real.

POST api/stripe/webhook verifica assinatura sobre bytes originais limitados,
sem aceitar JSON reparsed. Eventos Stripe deduplicados por ID+hash. Eventos
checkout.session.completed/async_payment_succeeded, customer.subscription.*,
invoice.paid/payment_failed iniciam reconciliação da assinatura atual via API;
eventos fora de ordem não reaplicam snapshot antigo. Serializar por organização
a consulta Stripe e aplicação por lock distribuído/DB com fencing; uma consulta
vencida não aplica após consulta mais nova. Customer é fronteira de
propriedade; nunca confiar em metadata para mover assinatura entre organizações.
Aceitar resultado apenas para Price reconhecido com Customer/Subscription
corretos. Customer sem associação local é ignorado, não associado por metadata.
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
cancelamento, upgrade/downgrade e cota concorrente. Provider sandbox real e
produção ficam gates externos quando faltam credenciais. Impostos requerem
configuração fiscal do operador; automatic_tax não é habilitado por hipótese.
