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

## Compra pela tela de planos, telefone e cupons (NEX-51)

**Decisão do dono: não há confirmação de e-mail de nenhum tipo no fluxo de
compra** (nem link, nem código). "Validar" é só validação de formulário:
formato, campos obrigatórios e e-mail já cadastrado. O cadastro já entra na
conta na hora (NEX-42).

- **Compra sem sair da tela de planos.** Em `/pricing` e na seção de planos da
  landing, o botão de um plano pago abre um diálogo sobre os planos: "Criar
  conta" ou "Já tenho conta", com o plano escolhido visível; depois, no mesmo
  diálogo, o resumo (plano, cupom, valor de hoje e dos meses seguintes) e "Ir
  para o pagamento", que chama POST /api/dashboard/billing/checkout e vai para a
  Stripe. Com sessão, o diálogo abre direto no resumo. `/register`, `/login` e
  `/checkout` continuam funcionando por link direto, e `/checkout` também tem o
  campo de cupom.
- **Telefone obrigatório.** O cadastro por e-mail exige telefone brasileiro
  (DDD válido + celular de 9 dígitos começando com 9 ou fixo de 8 dígitos
  começando com 2 a 5), com máscara, gravado em E.164 em `user.phone`. Contas
  antigas e cadastros pelo Google veem um aviso no painel, uma vez por sessão do
  navegador, sem bloquear o uso; o telefone também fica em Configurações →
  Perfil. A área admin mostra o telefone do proprietário em Clientes. O
  telefone de quem compra vai para o Customer da Stripe quando ele é criado.
- **Cupons.** São criados e desativados na área admin (Admin → Cupons). Cada
  cupom vira, pela API, um Coupon e uma Promotion Code com o mesmo código na
  Stripe: percentual ou valor fixo em R$; duração "só o 1º mês" (`once`),
  "por N meses" (`repeating`) ou "recorrente" (`forever`); planos aplicáveis
  (nenhum marcado = todos); limite de usos e validade opcionais. A UNO grava o
  cupom em `coupons` e registra a criação e a troca de estado em `audit_logs`.
  Os planos aplicáveis são conferidos pela UNO (prévia e checkout); validade e
  limite de usos também ficam na Promotion Code, então a Stripe os aplica.
- **Melhor desconto.** O Checkout da Stripe aceita um único desconto. O
  servidor calcula o primeiro pagamento com o cupom e com a promoção do 1º mês
  (cupom `STRIPE_COUPON_<PLANO>`) e aplica o que deixar o primeiro pagamento
  menor. A tela informa "Cupom X aplicado" ou "Promoção do 1º mês mantida, que
  já é melhor que o cupom X". Em empate, fica a promoção, a não ser que o
  cupom também desconte os meses seguintes. O preço nunca vem do navegador: a
  prévia (POST /api/dashboard/billing/coupon/preview) é informativa e o
  checkout recalcula tudo.
- **Registro.** A intenção de checkout grava o código digitado, o desconto
  aplicado (`COUPON`, `FIRST_MONTH`, `NONE`) e o cupom. A reconciliação grava em
  `subscriptions` o cupom visto na assinatura do plano e o mantém depois que um
  desconto de uso único acaba. O Financeiro mostra os cupons usados, os
  pagamentos dos últimos 30 dias por tipo de desconto e o cupom de cada
  assinatura paga.
- **Voltar com outro cupom.** Se já existe um Checkout aberto para outro plano
  ou outro cupom, a sessão antiga é expirada na Stripe e uma nova é criada; se
  ela já foi paga, a resposta é 409 `checkout_in_progress` e o webhook conclui.
  Só um pedido com chave de idempotência nova substitui a sessão: a repetição
  de uma aba antiga, cuja intenção já foi substituída, recebe 409 e não expira
  a sessão mais nova.
- A prévia e o checkout com código têm limite por usuário
  (`UNO_COUPON_RATE_LIMIT`, padrão 10 por minuto) e por endereço
  (`UNO_COUPON_IP_RATE_LIMIT`, padrão 30 por minuto) contra enumeração de
  códigos. Toda recusa responde a mesma mensagem ("Cupom inválido ou
  indisponível para este plano."); o motivo (inexistente, inativo, expirado,
  esgotado, plano errado) vai só para o log (`billing.coupon.rejected`). A
  exceção é "Este cupom já foi usado nesta conta.", que só aparece para a
  própria organização.
- **Um uso por organização.** A Promotion Code é criada com
  `first_time_transaction` (o Customer da Stripe é a organização) e a UNO
  recusa o cupom se a organização já concluiu um pagamento com ele ou ainda o
  carrega na assinatura.
- **Cupom restrito a planos.** Além da conferência da UNO, o Coupon da Stripe é
  criado com `applies_to.products` dos planos escolhidos, então não desconta
  outro plano depois de uma troca ou pelo portal. Na troca de plano pela UNO,
  se o cupom da assinatura não vale para o plano de destino, o desconto é
  removido da assinatura, a confirmação avisa antes e a resposta informa
  (`couponRemoved`).
- **Criação sem órfãos.** Se a gravação local do cupom falhar depois de criado
  na Stripe, a Promotion Code é desativada.
- Migração `0018_rare_vance_astro`: `user.phone`, tabela `coupons` e colunas de
  cupom em `billing_checkout_intents` e `subscriptions`. **Implante o worker
  antes da aplicação** (é ele que aplica as migrações).
- Não verificado com a Stripe real: criação de cupom pela API, Checkout com
  Promotion Code e leitura de `subscription.discounts`. Os testes usam um
  provedor simulado.

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
