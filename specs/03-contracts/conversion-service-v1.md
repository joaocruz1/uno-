---
id: CONTRACT-UNO-CONVERSION-001
status: approved
---

# Conversão compartilhada e fila

Painel e API chamam o mesmo serviço de criação. O ator interno contém a
organização já autorizada, usuário ou chave de API e plano efetivo. Nenhuma
organização ou key de objeto recebida do cliente substitui essa autorização.

## Criação

1. Localizar a intenção por ID **e organização**, validar os bytes limitados e
   gravar snapshot em uma key privada nova. Fixar o SHA-256. A key da URL PUT não
   será usada pelo worker. Na API, os bytes multipart validados seguem o mesmo
   caminho de snapshot.
2. Em uma transação, bloquear a intenção, verificar validade/consumo, fixar a
   versão de template/engine, obter o período de uso, criar a conversão, reservar
   uma unidade e consumir a intenção. Registrar evento outbox para a fila nessa
   mesma transação. Excesso ou conflito desfaz todo o estado de negócio.
3. Remover snapshots órfãos somente se a transação não foi confirmada. Falha de
   publicação após commit preserva snapshot e outbox para recuperação. Publicar no BullMQ a partir do outbox com
   ID de job determinístico; queda entre commit e publicação é recuperável.
4. Responder `202` sem esperar a engine. Uma criação sem reserva confirmada não
   pode produzir uma conversão aceita. A intenção consumida não será reutilizada.

## Processamento

O job carrega apenas identificadores. O worker relê o registro da organização,
verifica estado/versões, obtém snapshot e confere SHA-256. Cada etapa grava
progresso e um evento real. Não usar percentuais baseados em temporizador.

Cada execução adquire um claim com token de tentativa e lease. Atualizações de
progresso, renovação e finalização exigem o token corrente e estado permitido.
Um processo antigo de job stalled não pode alterar uma tentativa nova.

Somente após o Validator aprovar o PDF, gravar o resultado em key privada por
tentativa e, em transação com compare-and-set do token, concluir a conversão,
fixar a referência desse artefato, confirmar a reserva uma
vez, registrar metadados/páginas e evento de conclusão para webhooks. Um retry
após queda reconhece o estado concluído sem consumir novamente. Tentativa já
concluída nunca sobrescreve estado com falha posterior. Uma tentativa vencida
remove apenas seu próprio objeto órfão; não sobrescreve o objeto publicado.

Falha determinística da engine encerra o job, libera a reserva e registra erro
seguro. Falha de infraestrutura pode repetir até o limite persistido. A última
falha libera a reserva. Jobs stalled e interrupções são recuperados pelo BullMQ;
estado e cota são a autoridade do banco, não o contador volátil do processo.

Lotes posteriores reutilizam esta operação dentro de uma transação que reserva
todos os itens aceitos. A conclusão de cada item é independente.

## Leitura e download

O painel envia `POST /api/dashboard/conversions` com `uploadIntentId`, `size`
e template opcional. A resposta aceita é `202` com `id`, `status: "queued"`,
`progress: 0`, `createdAt` e `requestId`. Um retry de intenção já consumida não
cria outra conversão; `409 upload_already_consumed` pode incluir o ID existente
da mesma organização para recuperar uma resposta perdida.

`GET /api/dashboard/conversions/:id` retorna o DTO validado em
`src/lib/conversion-model.ts`: estado/progresso reais, versão, dimensão,
timestamps, eventos de etapas e erro seguro. `download` e `original` contêm
somente URLs HTTP(S) assinadas e expiração; existem após conclusão validada e
enquanto os artefatos estiverem disponíveis. O preview original não é liberado
para um PDF cuja análise de segurança falhou.

Consultas, eventos, preview original, download e reprocessamento exigem ID e
organização. Downloads existem somente para registros concluídos e artefatos
não expirados. Retornar URLs assinadas de até cinco minutos e `no-store`.
Reprocessar cria outra conversão e reserva; não reabre a conversão anterior.

## Liberação de templates

Template/tamanho em produção exige release com evidência automática e prova
física registrada conforme `docs/printing-validation.md`. Desenvolvimento pode
testar uma versão DRAFT somente com opção explícita local; não permitir essa
opção em produção. Um erro `format_too_small` não gera resultado parcial nem
cobrança. A sugestão de formato em teste não equivale a certificação de impressão.
