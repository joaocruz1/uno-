---
id: CONTRACT-UNO-EXT-001
status: draft
spec: SPEC-UNO-001
---

# Extensão de navegador (v1)

Extensão Chrome Manifest V3 (Chrome, Edge, Brave, Opera) que converte as
etiquetas no momento em que o vendedor as baixa no painel do marketplace.
Ela não tem engine própria: envia o arquivo ao UNO e baixa o resultado. Código
em `extension/`, fora do lint, typecheck, testes e imagem Docker da raiz.

## Escopo

| Marketplace | Origem do download | Conversão | Cota |
| --- | --- | --- | --- |
| Mercado Livre | PDF de etiquetas (2 páginas por pedido) | lote assíncrono (`marketplace-lotes`) | 1 por pedido |
| Mercado Livre Full | `.zpl` / `.txt` | `zpl-lote` síncrono | não medida (igual ao painel) |
| Shopee | PDF de etiquetas | `shopee-lote` síncrono | não medida (igual ao painel) |
| TikTok Shop | PDF de etiquetas | `tiktok-lote` síncrono, só etiquetas | não medida (igual ao painel) |

Fora da v1: botão injetado nas páginas, junção etiqueta + NF-e do TikTok em dois
downloads, Excel da Shopee, `.zip` do ML, Firefox. Arquivos fora da tabela
passam sem toque.

## Captura

1. `chrome.downloads.onCreated`: só age quando a aba de origem (ou o
   `referrer`) é de um domínio de marketplace conhecido, o marketplace está
   ligado nas preferências e a extensão está conectada. O arquivo precisa ter
   cara de PDF (MIME `application/pdf` ou nome `.pdf`) ou ZPL (`.zpl`/`.txt`
   vindos do ML).
2. Os bytes são obtidos antes de cancelar o download original:
   - URL `http(s)`: `fetch` do service worker com `credentials: "include"`;
   - URL `blob:`: o script de conteúdo da aba lê o blob (a página não consegue
     revogá-lo antes de 60 s, porque `URL.revokeObjectURL` é adiado no mundo
     MAIN);
   - URL `data:`: decodificada localmente.
   Se não der para obter os bytes, o download original segue intacto.
3. Com os bytes em mãos, o download original é cancelado e apagado da lista.
4. Sucesso: baixa `uno-<marketplace>-<data>.pdf`. Falha de qualquer tipo: baixa
   o arquivo original de volta e mostra notificação com o motivo. O vendedor
   nunca fica sem etiqueta por causa da extensão.
5. Downloads iniciados pela própria extensão são ignorados pela captura.

## Conexão (token da extensão)

- O popup abre `${UNO}/extensao/conectar?state=<aleatório 32 bytes base64url>`.
- A página (logado; senão, login e volta) mostra a organização e o botão
  "Conectar". O clique faz `POST /api/dashboard/extension-tokens` (mesma
  origem, sessão) com `{ name }` e recebe `{ token }` uma única vez.
- A página entrega `{ type: "uno-extension-connect", state, token }` por
  `window.postMessage` para a própria origem. O script de conteúdo da extensão,
  que só roda nessa rota do domínio do UNO, aceita a mensagem se
  `event.source === window`, a origem for a do UNO e o `state` for o pendente
  (uso único, expira em 10 min). O token vai ao `chrome.storage.local`.
- Token: `unoext_` + 32 bytes base64url. Banco guarda só SHA-256, prefixo de 14
  caracteres, organização, usuário, nome, último uso e revogação. Até 10 ativos
  por organização. Qualquer membro conecta; o próprio usuário, OWNER ou ADMIN
  revogam. Não exige o adicional "+ API".
- Um token autentica como o usuário que o criou, na organização dele. Usuário
  removido da organização perde o acesso na próxima requisição (a associação é
  conferida em toda chamada).

## API da extensão

Base `/api/extension/v1`, `Authorization: Bearer unoext_...`. Sem cookie, sem
CSRF (não é credencial ambiente) e sem CORS (o service worker com
`host_permissions` não precisa). Erros seguem o envelope padrão
`{ requestId, error: { code, message } }`. Rate limit por organização igual ao
de intenções de upload.

- `GET /me` → `{ organizationName, userName, planId, usage: { used, limit } }`.
- `POST /convert?marketplace=mercado-livre|mercado-livre-full|shopee|tiktok`
  com corpo multipart `file` (um arquivo):
  - síncronos: `200 application/pdf` com os cabeçalhos `x-uno-*` do painel;
  - ML: `202 { loteId, itemCount }`; o arquivo vira intenção de upload
    consumida pelo mesmo `createMarketplaceLote` do painel (tamanho 100×150,
    sem numeração).
- `GET /lotes/:id` → visão do lote (igual ao painel).
- `GET /lotes/:id/download` → `{ url, expiresAt }` assinado (≤ 300 s).
- `DELETE /session` → revoga o próprio token (botão "Desconectar").

Token inválido, revogado ou de usuário sem organização: `401 unauthorized`; a
extensão volta ao estado desconectado.

## Painel

- `/extensao/conectar`: tela de consentimento descrita acima.
- `/dashboard/extensao`: instruções de instalação e lista de navegadores
  conectados (nome, prefixo, criado, último uso) com "Desconectar".

## Privacidade

A extensão não lê o conteúdo das páginas dos marketplaces, não envia nada além
do arquivo baixado e não guarda o PDF depois da conversão. As permissões pedidas
são `downloads`, `storage`, `notifications`, `tabs` e `host_permissions` dos
domínios listados em `extension/src/marketplaces.js` e do UNO.
