---
id: CONTRACT-UNO-HISTORY-001
status: approved
spec: SPEC-UNO-001
---

# Histórico e reprocessamento

`GET /api/dashboard/conversions` exige sessão verificada e organização do ator.
Parâmetros: `q` literal case-insensitive sobre nome, até 120 caracteres;
`status` queued/processing/completed/failed; `source` dashboard/api; `from`
inclusivo e `to` exclusivo RFC3339; `limit` padrão 20, máximo 50; cursor opaco
validado e associado aos filtros. Ordenar createdAt DESC, id DESC. Não retornar
keys, URLs assinadas ou eventos completos na lista. Retornar items e nextCursor.
Ocultar deleting/deleted. Expirados podem permanecer com ações indisponíveis.

Detalhe reutiliza GET por ID e organização. URLs sob demanda, no-store,
validade mínima entre 300 segundos e retenção restante. Arquivo ausente gera
indisponibilidade segura. Original apenas após conversão validada.

`POST /api/dashboard/conversions/:id/reprocess` recebe size e template opcionais.
Omissão reutiliza configuração original, sem trocar silenciosamente versão.
Exige mesma origem, sessão, rate limit e Idempotency-Key (16–128 caracteres).
Mesma organização/origem/chave/parâmetros retorna a mesma nova conversão;
parâmetros diferentes com a mesma chave retornam 409.

Origem completed/failed, snapshot retido e hash conhecidos: nova cópia imutável,
novo ID/reserva/outbox/retentativas/retenção; registrar origem. Ativa retorna 409,
expirada/indisponível 410, ausente/outra organização 404. Conferir bytes/tamanho/
hash; revalidar origem com lock, plano/template e cota no commit. Fonte permanece
intacta. Confirmar somente sucesso. Falhas liberam somente reserva nova.
Commit incerto exige reconciliação com lock; nunca apagar objeto potencialmente
confirmado. Retenção posterior da fonte não remove cópia nova.

Testes: escopo, paginação estável, busca literal, datas, assinatura próxima à
expiração, fonte ausente/ativa/expirada, idempotência concorrente e conflito,
cota, mudança de plano/template, commit incerto e reserva independente.
