---
id: CONTRACT-UNO-UPLOAD-001
status: approved
---

# Upload privado do painel

`POST /api/dashboard/uploads` exige sessão verificada, membership na organização
selecionada e origem do painel. O corpo JSON contém `contentLength` inteiro
positivo, `contentType: "application/pdf"`, `originalFileName` opcional (somente
para exibição) e `checksumSha256` hexadecimal opcional. O limite deriva do plano.

A resposta contém `requestId`, `id`, `uploadUrl`, `headers` e `expiresAt`. O cliente
envia os bytes diretamente com PUT ao objeto privado. A URL expira em até cinco
minutos; não contém dados de etiqueta ou nome de arquivo no caminho.

Antes de emitir a URL, um limitador distribuído por organização permite, por
minuto, 30 intenções no Free/Starter, 60 no Pro e 120 no Business. Uma organização
pode manter no máximo `max(10, limiteDeLote)` intenções válidas e não consumidas.
O limite de pendências é aplicado atomicamente. O excesso retorna `429` com
`Retry-After`, sem disponibilizar outra URL de upload. São limites operacionais
iniciais configuráveis, separados da cota mensal de conversões.

A criação da conversão consumirá o ID dessa intenção. Antes do consumo, o
servidor conferirá organização, validade, tamanho real, tipo, assinatura `%PDF-`
e checksum quando informado. O consumo será atômico na mesma transação da
reserva de cota e criação do registro de conversão; uma intenção não pode gerar
duas conversões. A análise de páginas, recursos, senha e template é da engine.

A URL PUT permanece reutilizável até expirar. Por isso, o consumo obtém e valida
os bytes uma única vez, calcula SHA-256 e grava um snapshot em uma nova key
privada assinável somente pelo servidor. A conversão aponta para esse snapshot,
e o worker confere seu hash antes de processar. Nunca enfileirar o objeto mutável
da intenção diretamente após uma verificação HEAD.

O storage expõe operações internas de PUT, HEAD, GET limitado/range, DELETE e
assinatura de download. Todas as leituras e URLs para o usuário devem decorrer
de uma autorização de registro da organização; nunca de uma key informada pelo
cliente. Downloads têm expiração curta e cache privado. Nenhum provedor recebe
o documento via observabilidade, e nenhum log registra seu conteúdo ou URL
assinada.
