# UNO — guia de contexto para o agente

Leia este arquivo antes de qualquer trabalho. As regras obrigatórias estão em
[`AGENTS.md`](AGENTS.md); este guia explica o que é o produto, como ele está
montado e em que pé está. Última atualização: 2026-10-08.

Responda ao dono do projeto em português (pt-BR), de forma direta.

## O que é

"Duas páginas. Uma etiqueta." Um SaaS que recebe o PDF de duas páginas de um
pedido de marketplace (etiqueta logística + DANFE simplificada) e devolve uma
única etiqueta 100 × 150 mm, com:

1. cabeçalho opcional de separação (quantidade, produto, SKU, variação);
2. a etiqueta logística original, sem espaços em branco;
3. uma faixa "DANFE SIMPLIFICADA - ETIQUETA" (tipo, NF, série, emissão e o
   código de barras original da chave de acesso).

A referência visual escolhida pelo dono é o produto Etiqjá: uma etiqueta 10×15
compacta, não uma página longa preservando tudo. A primeira versão (100 × 250,
preservação integral) foi rejeitada.

## Escopo do MVP

- Conversão individual pelo painel, com prévia antes/depois e download.
- Teste anônimo na landing: uma etiqueta, em memória, uma vez por visitante.
- Lotes com saída em ZIP, histórico e reprocessamento.
- API pública assíncrona (`/api/v1`) e webhooks assinados, para ERPs.
- Organizações, membros e convites.
- Assinaturas pela Stripe com cota mensal.
- Área administrativa: financeiro, clientes, atividade, chaves, conexões e
  liberação de templates.
- Um único template: **Mercado Livre 1.0.0**. Os demais marketplaces da landing
  são roteiro ("em breve"), não código.

## Arquitetura

```
PDF → Analyzer → Template Detector → Content Extractor → Layout Engine → PDF Composer → Validator → PDF
```

- **Engine** (`src/engine/`): as seis etapas são genéricas. Cada layout é uma
  definição versionada em `src/engine/templates/`. Documento desconhecido ou
  ambíguo é recusado; não existe "melhor esforço". O Validator decodifica todos
  os códigos da saída a 203 e 300 dpi e compara com a entrada.
- **Aplicação** (`src/app/`): Next.js 16 App Router, React 19. As áreas
  autenticadas usam `dynamic = "force-dynamic"` (o build não tem banco).
- **Serviços** (`src/server/`): conversões, lotes, API, webhooks, cobrança,
  organizações, admin, retenção, teste anônimo. Toda operação protegida
  autoriza no servidor e é restrita à organização.
- **Worker** (`src/workers/`): BullMQ. Processa conversões, lotes, entregas de
  webhook e retenção. A engine roda em processo isolado com vigia de memória
  (usa `ps`, por isso a imagem precisa de `procps`).
- **Dados**: PostgreSQL + Drizzle (migrações em `drizzle/`), Redis (filas e
  limites), armazenamento S3 privado com links assinados.
- **Padrões que não podem quebrar**: outbox transacional, idempotência, cota
  atômica, webhooks com HMAC-SHA-256 e proteção contra SSRF, segredos cifrados
  com AES-256-GCM, CSP gerada no build a partir de `S3_ENDPOINT`.

A especificação e os contratos ficam em `specs/`; mudança de comportamento
começa por lá.

## Planos e cobrança

| Plano | Preço/mês | Etiquetas/mês |
| --- | --- | --- |
| Free | R$ 0 | 10 |
| Starter | R$ 9,99 | 300 |
| Pro | R$ 15,99 | 2.000 |
| Business | R$ 29,90 | 10.000 |

- **Nenhum plano inclui API.** API, chaves e webhooks exigem o adicional
  **"+ API", R$ 50/mês**, sobre qualquer plano pago.
- O adicional é uma **assinatura Stripe separada** no mesmo cliente. Motivo: o
  portal da Stripe não troca de plano em assinatura com dois produtos. O estado
  fica em `subscriptions.api_addon_*`; o direito efetivo é "plano pago em vigor
  E adicional ativo" (`src/server/billing/entitlements.ts`).
- A fonte dos preços é `src/lib/plans.ts`. `pnpm stripe:setup <arquivo .env>`
  cria os preços na conta daquela chave, arquiva os antigos e grava os IDs.

## Produção

- Hospedagem: Easypanel, projeto `api-nextpy`.
  - `uno`: aplicação web (`Dockerfile`, porta 3000).
  - `uno-worker`: worker (`Dockerfile.worker`); aplica as migrações ao iniciar.
  - `db_uno`: PostgreSQL. `redis_uno`: Redis.
- URL: https://api-nextpy-uno.1nwz76.easypanel.host
- Arquivos: Cloudflare R2 (URLs path-style; o checksum do upload vai como
  cabeçalho assinado).
- E-mail: SMTP autenticado (Gmail) via nodemailer.
- O deploy é manual: push para `main` e depois "Implantar" em cada serviço.
  **Quando houver migração, implante o worker antes da aplicação.**
- O Easypanel repassa todas as variáveis de ambiente como build args.
- `UNO_ALLOW_UNRELEASED_TEMPLATES=true` está ligado: decisão do dono de abrir em
  beta sem a prova física de impressão. Deve ser desligado quando o template
  for liberado pelo fluxo normal.

## Em que pé está (2026-10-08)

Verificado em produção:

- aplicação e worker no ar; 42 páginas e rotas respondendo logado como admin;
- uma conversão real pelo painel, de ponta a ponta, com PDF sintético
  (upload → fila → resultado → download do R2 → cota 1/10).

Feito, mas **não verificado**:

- Stripe real: planos, adicional, portal e webhook criados na conta. O dono
  informou ter colado as variáveis e implantado a versão com os novos preços,
  mas isso ainda não foi conferido, e nenhum pagamento foi feito.
- Telas da mudança de preços (página de preços, card "+ API", financeiro) não
  foram abertas no navegador.
- API pública, webhooks, lotes e o teste anônimo da landing não foram
  exercitados em produção.
- Os testes de navegador (e2e) não rodaram depois das últimas mudanças.

Pendências:

1. Conferir o deploy dos novos preços e fazer uma assinatura real de teste
   (plano e adicional), observando a entrega do webhook.
2. Prova física de impressão e liberação do template; depois desligar o modo
   beta.
3. Trocar todos os segredos que passaram pelo chat (banco, Redis, senha de app
   do Gmail, chave do R2, `BETTER_AUTH_SECRET`, `WEBHOOK_ENCRYPTION_KEY`, chave
   e segredo de webhook da Stripe) e fechar as portas externas do banco e do
   Redis.
4. Decidir se o repositório continua público e adicionar uma licença.
5. A faixa resumida da DANFE omite protocolo, remetente e destinatário; a
   adequação fiscal é decisão de quem opera.

## Como trabalhar aqui

- Use `corepack pnpm` (o `pnpm` não está no PATH).
- `corepack pnpm check` roda lint, typecheck, testes e build; rode nas
  fronteiras de fase. Testes usam PGlite e somente dados sintéticos.
- Ambiente local: `.env.local` (Postgres, Redis, emulador S3 `pnpm dev:s3`,
  Mailpit, Stripe em modo de teste). `UNO_ALLOW_DRAFT_TEMPLATES=true` libera o
  template em desenvolvimento.
- Leia `node_modules/next/dist/docs/` antes de escrever código específico do
  Next: esta versão difere do que se conhece.
- Segredos ficam só em arquivos ignorados pelo Git (`.env.local`,
  `.env.production`, `.tmp/`). Nunca versione etiquetas, notas ou credenciais
  reais; o PDF real do dono fica fora do repositório.
- Não afirme que integração externa, qualidade de impressão ou liberação em
  produção foi verificada sem evidência. Diga o que foi testado e o que não foi.
- Armadilhas já encontradas: o `.dockerignore` precisa manter `tests/fixtures`;
  a idade de workspaces da engine usa `mtimeMs`; o cadastro tem limite de 3 por
  minuto por IP, o que afeta os e2e; o teste anônimo tem limite de tentativas
  por IP, então não faça polling nele em produção.

## Onde olhar

| Assunto | Arquivo |
| --- | --- |
| Regras do projeto | `AGENTS.md` |
| Produto e contratos | `specs/` |
| Deploy | `docs/deploy.md` |
| Cobrança | `docs/billing.md` |
| API pública | `docs/api-v1.md` |
| Segurança | `docs/security.md` |
| O que foi e não foi validado | `docs/validation.md`, `docs/implementation-checklist.md` |
| Prova de impressão | `docs/printing-validation.md` |
