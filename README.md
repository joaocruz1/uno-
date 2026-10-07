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
```

Os requisitos e contratos estão em `specs/`; o estado verificável de cada fase
está em [docs/implementation-checklist.md](docs/implementation-checklist.md), e
as evidências em [docs/validation.md](docs/validation.md). Itens não verificados
não representam recursos certificados em produção.

Use somente dados sintéticos nos testes versionados. O PDF real fornecido pelo
usuário, suas imagens, textos e códigos ficam fora de Git e telemetria.
