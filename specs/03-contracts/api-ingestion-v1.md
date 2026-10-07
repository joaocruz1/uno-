---
id: CONTRACT-UNO-INGESTION-001
status: approved
spec: SPEC-UNO-001
extends: CONTRACT-UNO-API-001
---

# Chaves e ingestão pública

GET/POST/DELETE dashboard/api-keys exige OWNER/ADMIN. Pro/Business cria/usa;
downgrade permite listar/revogar existentes. Segredo32bytes aleatórios exibido
uma vez; persistir SHA256/prefixo/metadados, sem scopes extras nesta versão.
Ator interno distingue usuário de apiKey, usuário nulo nas conversões API,
source=api e proveniência apiKeyId. Revalidar revogação/expiração/plano no início
e commit após upload longo. Limite Redis por organização antes de ler corpo.

Busboy em stream, nunca request.formData(). Conversão exatamente um file;
lote files repetidos até limite vigente. Rejeitar campos desconhecidos/duplicados,
extras/MIME/magic inválidos, truncamentos e limites. Um multipart S3 de arquivo
aberto por request, buffers limitados/backpressure/hash SHA256 e contagem reais.
Máximo de engine100MB por arquivo além do plano; agregado fica em storage.
Configuração pode aparecer após arquivos mas deve ser validada antes de aceitar.
Limitar metadados/quantidade/deadline; abort propaga parser/streams/S3; desconexão
pré-commit aborta preparação. Registrar keys/tentativas para limpeza recuperável;
nunca usar nome do cliente como path. Limitar uploads simultâneos e bytes
preparados por organização, inclusive API. Sem transação DB aberta na transferência.

Idempotency-Key opcional; ausência gera identidade exclusiva sem dedupe.
Escopo organização+rota, não apiKey. Fingerprint inclui opções efetivas e arquivos
na ordem recebida com hash/tamanho/nome normalizado. Duplicados são itens distintos.
Replay precisa verificar conteúdo; igual retorna mesmo recurso, divergente409
idempotency_conflict. Em preparação409 idempotency_in_progress com Retry-After.
Transação final recurso+Nreservas+outbox+resposta idempotente ou zero; não chamar
Nadmissões independentes. Reutilizar núcleos compartilhados com origem/ator e
snapshots preparados. Replay mantém IDs e usa requestIdHTTP atual. Commit incerto
reconcilia sob lock; inconclusivo preserva snapshots. Aceitos continuam após downgrade.

Tests: revogação/downgrade durante upload, foreign tenant, POSTs concorrentes,
conflito conteúdo/opções/ordem, campos tardios, truncamento/limites/desconexão,
memória/reserva integral/commit perdido. Uploads no Railway; duração/tamanho
operacional50GB só podem ser anunciados após gate real do provedor.
