# UNO

Duas páginas. Uma etiqueta. Projeto independente em Next.js, com painel e API
compartilhando serviços, PostgreSQL, Redis e armazenamento S3 privado.

## Desenvolvimento

Requer Node.js 24, pnpm e os serviços definidos em `compose.yaml`.

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
docker compose up -d
# Configure BETTER_AUTH_SECRET (mínimo 32 caracteres) e WEBHOOK_ENCRYPTION_KEY.
pnpm db:migrate
pnpm dev
# Em outro terminal:
pnpm worker
```

O envio de e-mails local usa Mailpit em `http://localhost:8025`. Produção usa
Resend. Configure o bucket privado `uno` e CORS com a origem exata do painel,
métodos PUT/GET/HEAD e cabeçalhos de upload. Nunca habilite acesso público.

Sem Docker, serviços locais equivalentes podem ser usados nas mesmas portas.
Para o emulador S3 de desenvolvimento:

```bash
# .env.local: S3_ACCESS_KEY_ID=S3RVER, S3_SECRET_ACCESS_KEY=S3RVER
# APP_URL deve corresponder à origem usada no navegador.
node --env-file=.env.local scripts/local-s3.mjs
```

## Qualidade e estado

```bash
pnpm check
pnpm test:e2e
# Com PostgreSQL, Redis, Mailpit e app local em 127.0.0.1:3100:
UNO_LOCAL_AUTH_E2E=1 pnpm exec playwright test tests/e2e/auth.spec.ts
# Com S3 e worker adicionais:
UNO_LOCAL_UPLOAD_E2E=1 pnpm exec playwright test tests/e2e/history.spec.ts
```

Os requisitos e contratos estão em `specs/`; o estado verificável de cada fase
está em [docs/implementation-checklist.md](docs/implementation-checklist.md), e
as evidências em [docs/validation.md](docs/validation.md). Itens não verificados
não representam recursos certificados em produção.

Use somente dados sintéticos nos testes versionados. O PDF real fornecido pelo
usuário, suas imagens, textos e códigos ficam fora de Git e telemetria.

## Engine e impressão

A engine usa seis etapas independentes e incorpora regiões do PDF digital,
preservando o conteúdo original. O worker deve usar o processo isolado;
Tesseract local com português e inglês auxilia arquivos escaneados.

Para testar o template inicial em desenvolvimento, configure
`UNO_ALLOW_DRAFT_TEMPLATES=true`. Essa opção é recusada em produção: cada
template/tamanho exige evidências automática e física antes da liberação.
`pnpm dev` e `pnpm build` preparam os assets locais versionados do PDF.js;
esses arquivos gerados ficam fora de Git e são copiados com suas licenças.

O formato padrão de 100 × 150 mm pode ser insuficiente. A engine bloqueia
composições que não cabem na escala original. O exemplo privado passou na
validação automática em 100 × 250 mm; isso não certifica sua impressão.

Gere candidatos exclusivamente sintéticos com dimensões explícitas:

```bash
pnpm proof:print --width 100 --height 250
pnpm proof:print --width 100 --height 250 --additional
pnpm proof:print --width 100 --height 250 --scanned
```

Cada pacote privado de desenvolvimento inclui entrada, saída, relatório e
hashes. Siga [o protocolo físico](docs/printing-validation.md) antes de liberar
uma combinação template/tamanho em produção.
