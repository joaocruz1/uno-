---
id: CONTRACT-UNO-MANAGEMENT-001
status: approved
spec: SPEC-UNO-001
---

# Organizações e administração

Identidade verificada e mesma origem nas mutações. Toda operação relê membership
vigente; seleção por cookie é preferência, não autorização. Listar/trocar
organizações autentica identidade independentemente de cookie selecionado,
permitindo recuperação após remoção. Provisionamento pessoal ocorre somente
uma vez e nunca restaura membership removida ou eleva papel em requests futuros.

GET/POST dashboard/organizations lista organizações próprias e cria {name}
atomicamente com um OWNER e assinatura FREE. POST /:id/select verifica membership
e grava cookie seguro. PATCH /:id altera nome por OWNER/ADMIN. GET /:id/members
lista membros apenas para organização autorizada. PATCH/DELETE /:id/members/:userId
altera/remove membros sob as regras seguintes. Não excluir organizações nesta fase.

Decisão delimitada: exatamente um OWNER, consistente com owner_user_id.
Só OWNER gerencia ADMIN e transfere propriedade. ADMIN gerencia MEMBER sem
elevar privilégios. POST /:id/transfer-ownership bloqueia organização e memberships,
troca proprietário e rebaixa anterior a ADMIN atomicamente. Não remover/rebaixar
OWNER por outro caminho. Remoção/rebaixamento perde autorização na próxima request.

POST/GET /:id/invitations cria/lista convites por OWNER/ADMIN; DELETE /:id/invitations/:id
revoga. POST dashboard/invitations/accept aceita token para identidade verificada
com e-mail correspondente. Token aleatório persistido somente como hash, prazo
operacional configurável e consumo único. Aceitação sob lock relê autorização
do emissor, papel permitido, estado/expiração e e-mail normalizado; replay não
duplica membership. Convites são enviados pelo provedor configurado; testes usam
somente Mailpit e endereços sintéticos. Limites operacionais/rate limits configuráveis.

# Administração e liberação

Exigir platformRole ADMIN e allowlist operacional. ADMIN de organização não
concede privilégio de plataforma. GET api/admin/* oferece métricas e metadados
paginados de organizações, assinaturas, uso, conversões, falhas e jobs: IDs,
estados, versões, tempos, contadores e códigos seguros. Nunca PDFs, previews,
URLs assinadas, conteúdo extraído, nomes de documentos ou segredos. Não permitir
alteração arbitrária de cobrança/cota; acesso documental exige membership normal.

GET admin/templates e POST /:id/releases operam somente versões reconhecidas
pela engine. Release vincula engine, template/versão, dimensões e execução
automática aprovada. Recebe relatórios estruturados completos conforme protocolo
docs/printing-validation.md e calcula hashes dos bytes persistidos; strings SHA
declaradas sem relatório não são evidência suficiente. Prova física registra
operador, impressora/configurações, escala100%, medidas/tolerância, preservação
e leituras previstas. Relatório vazio/divergente não libera. Administrador atesta
a prova realizada; sistema não inventa resultados. Publicação atômica/idempotente
pela combinação e evidência. Mudança de versão/tamanho exige nova prova.

Auditoria transacional com IDs/ator/ação/resultado/alterações, sem tokens, PDFs
ou conteúdo fiscal. Testes: foreign org, seleção revogada, não reelevação,
transferências concorrentes, último OWNER, elevação por ADMIN, convite expirado/
revogado/e-mail divergente/replay, admin sem ambas credenciais, relatório ausente/
divergente e release concorrente. Impressão física real permanece gate externo.
