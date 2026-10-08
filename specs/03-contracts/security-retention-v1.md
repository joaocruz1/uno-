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
após abandono; não seguir symlinks nem aceitar paths do cliente. A engine roda em
filho residente supervisionado: cada processo pai cria uma raiz privada (0700,
`uno-engine-*`) que é o TMPDIR dos seus filhos; cada job usa workspace próprio
`job-<uuid>` (0700) dentro dela, criado e removido pelo filho e removido de novo
pelo pai; a recuperação de abandonados ignora raízes vivas do próprio processo.
Um filho atende um job por vez e é aposentado (SIGKILL do grupo) em prazo, RSS do
grupo acima do limite durante o job, saída/erro, falha de IPC, violação de
protocolo ou falha do handler de progresso; também após N jobs, ocioso por tempo
limitado (nunca acima da idade de abandono) ou com amostra de RSS ociosa acima do
limite. Erro tipado da engine não aposenta o filho. Entrada/saída,
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
processos e término de grupo filho. Subprocesso supervisionado residente (heap
limitado, vigia de RSS do grupo por `/proc` com fallback `ps`, prazo por job
contado desde a chamada, inclusive a espera por filho livre) é contenção de
recursos, sem promessa de isolamento completo do OS. Testes: exclusão repetida/
parcial, leases, retenção concorrente, commit desconhecido, snapshot transferido,
multipart abandonado/symlink e sentinelas pessoais na telemetria; nenhum PostHog
sem consentimento. Backups/lifecycle reais são gates operacionais, sem promessa
de remoção física instantânea.
