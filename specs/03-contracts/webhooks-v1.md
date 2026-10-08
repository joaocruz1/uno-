---
id: CONTRACT-UNO-WEBHOOK-001
status: approved
spec: SPEC-UNO-001
---

# Webhooks de saída

OWNER/ADMIN de organização com o adicional de API ativo sobre um plano pago
vigente (Starter, Pro ou Business) configura endpoints em dashboard/webhooks.
POST recebe URL HTTPS pública e eventos permitidos. Segredo aleatório exibido
uma vez; persistência AES-256-GCM com chave de ambiente versionada, IV único e
AAD vinculada à organização/endpoint. GET nunca retorna ciphertext ou segredo.
DELETE/desativação interrompe novas tentativas. Perda do adicional de API ou do plano pago também
impede envio (código plan_required); não enviar retrospectivamente todos os eventos ao novo endpoint.
Limite operacional inicial configurável: dez endpoints ativos por organização.

Eventos transactional outbox: conversion.completed, conversion.failed,
batch.completed. Fan-out cria uma delivery por endpoint/evento com índice único.
Cada POST contém id/type/createdAt/organizationId/data com IDs/estado/contadores
e erro seguro. Não contém nome, texto, bytes, códigos, keys ou links privados.
ID de delivery estável entre retries; timestamp/assinatura novos por tentativa.
O corpo transmitido permanece imutável entre retries. Fan-out só considera
endpoints existentes e habilitados quando o evento ocorreu. Cada conexão
revalida endpoint/plano; desativação ou perda de direito cancela tentativas
pendentes, que não são reenviadas automaticamente após reativação.
HMAC exato conforme public-api-v1: timestamp + ponto + bytes UTF-8 do corpo.
Retornar X-Label-Timestamp/Delivery/Signature. Documentar replay window e
deduplicação no receptor, incluindo exemplo de comparação em tempo constante.

Um envio inicial + cinco retries em 1min/5min/30min/2h/12h após falha anterior.
2xx confirma, outros códigos/timeouts/falhas de rede repetem. Persistir estados,
attemptCount, nextAttemptAt e histórico sem response body. Claim/lease/token
evita atualizar resultado de tentativa vencida; retentativa pós-queda pode
reentregar e exige dedupe por delivery no receptor. Estado do banco é autoridade.

Proteção SSRF em cadastro e cada envio: HTTPS/porta443, sem credenciais/fragmento,
hostname público; resolver todos A/AAAA e negar ranges não públicos, loopback,
link-local, multicast, privados, reservados e IPv4 mapeado em IPv6. Pin de IP
validado na conexão mantém Host/SNI para TLS. Sem redirect, proxies de ambiente
ou logs de URL completa. Timeout inicial10s configurável; resposta descartada
e limite64KiB. Endpoints internos não são permitidos nem por configuração prod.
Testes de rede podem injetar transporte sem desativar validação de produção.

GET retorna configuração e histórico paginado por organização. Retry manual,
se implementado, não muda evento/ID nem reabre reserva de cota e exige papel
autorizado. Audit logs guardam apenas IDs/ação/ator.

Tests: crypto/tampering/org AAD, exactbody/timestamp/ID, dedupe fanout,
retry schedule, claim stale, downgrade/revocation, crossorg, SSRF/DNS rebinding,
redirect/bodylimit/timeout. Entrega externa real exige endpoint público do
operador; não enviar mensagens ou documentos de cliente durante testes.
