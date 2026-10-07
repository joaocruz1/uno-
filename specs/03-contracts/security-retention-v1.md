---
id: CONTRACT-UNO-SECURITY-001
status: approved
spec: SPEC-UNO-001
---

# Retenção, segurança e telemetria

Expiração é fixada na aceitação; planos posteriores não alteram artefatos já
aceitos. Servidor revalida expiração em download/reprocessamento. Limpeza limitada
e idempotente bloqueia registro expirado, marca deleting, exclui objetos
registrados e confirma deleted só após exclusão. Falhas ficam recuperáveis.
Tombstones preservam IDs/FKs/origem/contabilidade/eventos necessários e removem
nome original/metadados pessoais dispensáveis. Nunca apagar consumo confirmado.
Trabalho ativo exige fencing antes da exclusão; não apagar sob lease válido.
Liberar só reserva pendente. Concluir agregado do lote antes de tombstones dos
filhos mudarem a contagem. Autorizações novas negam deleting/deleted.

Sessões expiradas removem staging/snapshots não transferidos; ACCEPTED remove
somente staging, inputs pertencem à conversão. Respeitar última validade PUT
registrada. Lifecycle staging/multipart incompleto é proteção operacional adicional.
Órfãos exigem proprietário/tentativa comprovados e rechecagem sob lock após
reconciliação de commit desconhecido. Banco indisponível/inconclusivo preserva
objetos. Idade/consulta isolada não prova orfandade. Candidatos rastreiam key,
organização, proprietário/tentativa e prazo; sem dono comprovável apenas inventário
operacional, sem exclusão ampla. Nenhuma varredura indiscriminada do bucket.

Temporários privados por execução são limpos em sucesso/falha/timeout e recuperados
após abandono; não seguir symlinks nem aceitar paths do cliente. Entrada/saída,
páginas, prazo, memória e concorrência são limitados; medir orçamento agregado
parent/preparação/ZIP/filho. Valores inválidos de segurança falham explicitamente.
Aplicar webhooks-v1 (AAD/segredos, SSRF/DNS pin/TLS, sem redirects/proxies,
timeout/resposta limitada) e revogar chaves/autorização nas próximas requests.

Sentry recebe adaptador de esquema permitido e beforeSend adicional: somente
código seguro, etapa, duração, contadores, versão/ambiente/ID técnico necessário.
Remover request/body/headers/cookies, email/usuário, URLs/query, nomes/conteúdo
PDF/OCR/códigos, payloads, exceções brutas, breadcrumbs não autorizados e anexos.
Transações usam mesma política. PostHog desativado por padrão; eventos manuais
somente após opt-in, whitelist, sem email/identify/autocapture/session replay/
pageview automático. Revogação interrompe envio. Logs nunca contêm segredos.

Deploy sem root, aplicação read-only, temporários privados, limites memória/CPU/
processos e término de grupo filho. Subprocesso supervisionado é contenção de
recursos, sem promessa de isolamento completo do OS. Testes: exclusão repetida/
parcial, leases, retenção concorrente, commit desconhecido, snapshot transferido,
multipart abandonado/symlink e sentinelas pessoais na telemetria; nenhum PostHog
sem consentimento. Backups/lifecycle reais são gates operacionais, sem promessa
de remoção física instantânea.
