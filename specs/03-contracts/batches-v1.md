---
id: CONTRACT-UNO-BATCH-001
status: approved
spec: SPEC-UNO-001
---

# Lotes

Uma sessão de staging do painel dura 24h (prazo operacional inicial configurável),
separada do lote aceito. PUTs privados duram no máximo cinco minutos. Emitir
intenção apenas ao iniciar cada arquivo; renovar somente itens não finalizados.
Finalizar cada item lê bytes limitados, valida MIME/magic/tamanho/hash e preserva
snapshot imutável. Não depender da URL PUT ou reter todos os arquivos em RAM.
Sessão/itens sempre pertencem à organização autorizada. Limitar contagem ao plano
vigente e rate-limit. Abandono não reserva cota; limpeza remove staging expirado.

POST dashboard/batch-uploads recebe manifesto de itens (clientItemId, nome,
contentLength, checksumSha256) e size/template, cria sessão e IDs. POST
sessão/items/:id/upload emite/renova PUT; POST sessão/items/:id/complete preserva
snapshot (ready ou 202 preparing); GET sessão recupera estados. POST
dashboard/batches aceita uploadSessionId e Idempotency-Key. Limitar itens/bytes
preparados simultâneos por organização além da contagem de cada sessão:
até 2× batchLimit itens e 2× batchLimit×maxFileBytes bytes por plano.
Após aceitação, sessão não pode ser alterada. API multipart faz staging interno
sequencial limitado e chama o mesmo serviço final; sem carregar agregado em RAM.

Commit trava sessão+itens+plano+período, exige todos ready e dentro dos limites,
cria batch+Nconversões+Nreservas+outbox na mesma transação ou zero. Transferência
do snapshot imutável ao item aceito é permitida sem cópia, com propriedade
registrada atomicamente. Cada conversão mantém key única. Snapshot aceito jamais
é removido por limpeza de staging. Idempotência escopada por organização/rota/
chave/hash; concorrência retorna a mesma operação, conflito 409. Commit incerto
reconcilia com lock e preserva snapshots enquanto não houver prova de rollback.

Itens processam independentemente pelos claims/retries/validador já definidos.
Progresso agregado é calculado dos estados/eventos persistidos. Falhas individuais
liberam suas reservas; resultados aprovados confirmam sua unidade.

Depois dos itens terminais, lote permanece processing, phase=packaging. ZIP64
somente dos resultados concluídos, com nomes gerados por ID (sem paths do
cliente), stream/backpressure e um input aberto por vez. Multipart privado com
limite configurado, timeout/abort e key por tentativa. Não bufferizar 500 PDFs.
Claim/lease e compare-and-set controlam publicação; commit incerto preserva
objeto potencialmente publicado. Retenção do ZIP não supera o menor prazo dos
itens. Retries de arquivo não refazem conversões nem cobram novamente.

Terminal completed somente após ZIP publicado (um ou mais resultados). Sem
resultados: failed. Falha final de packaging: failed/archive_failed; resultados
individuais e suas cotas permanecem válidos. Evento batch.completed exatamente
uma vez via outbox, após estado terminal, com status e contadores.

GET dashboard/batches lista resumo; GET/:id retorna estados/contadores,
timestamps/phase, archive; GET/:id/items pagina itens (máximo50); GET/:id/download
retorna ZIP assinado sob demanda (TTL <=300s e retenção restante).
Campos de erro seguros; nenhuma key interna ou informação extraída. Downloads
individuais reutilizam consulta da conversão e só existem após validação.

DTO do lote: id/status/phase/progress, counts(total,queued,processing,completed,
failed), archive(status,expiresAt?,error?), createdAt/updatedAt/completedAt?/
artifactsExpireAt?. Limite total de saída ZIP configurável, padrão100GiB, validado
durante stream; timeout próprio de packaging, padrão30min. Valores operacionais
não alteram limites de arquivos ou de cotas do plano.

Testes: limite de contagem/tamanho, todos-ou-zero e cota concorrente,
idempotência/consumo de sessão, isolamento, vencimento de PUT independente de
ready snapshot, mistura sucesso/falha, recuperação do worker/packaging,
ZIP seguro/streaming/retentativa/publicação única e expiração.
