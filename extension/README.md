# Extensão UNO (Chrome, Edge, Brave, Opera)

Converte as etiquetas no momento do download, dentro do painel do Mercado
Livre, da Shopee e do TikTok Shop. Contrato:
[`specs/03-contracts/browser-extension-v1.md`](../specs/03-contracts/browser-extension-v1.md).

JavaScript puro, Manifest V3, sem dependências e sem passo de bundler. Fica
fora do lint, do typecheck e da imagem Docker da raiz; as regras puras
(`src/files.js`, `src/marketplaces.js`) são testadas em
`tests/extension-files.test.ts`.

## Gerar o pacote

```bash
node extension/build.mjs
```

Gera `extension/dist/<host>/` e o `.zip` para a loja, apontando para produção.
Para outro ambiente: `node extension/build.mjs --url http://localhost:3000`.
O endereço vai no `config.js` e no `manifest.json` do pacote, então cada
ambiente tem o seu.

## Instalar para testar

1. `chrome://extensions` → ligar **Modo do desenvolvedor**.
2. **Carregar sem compactação** → escolher a pasta em `extension/dist/<host>/`.
3. A aba de conexão abre sozinha na instalação. Se não abrir, clique no ícone
   da UNO → **Conectar**.
4. Baixe uma etiqueta num dos marketplaces. Deve aparecer
   `uno-<marketplace>-<data>.pdf` na lista de downloads.

Depois de mudar o código: rode o build de novo e clique em recarregar na
extensão. Abas de marketplace abertas antes precisam ser recarregadas para
receber os scripts de conteúdo.

## Como funciona

- `src/background.js`: escuta `chrome.downloads.onCreated`. Se o download vem de
  um marketplace e parece PDF/ZPL, pausa, lê os bytes, confere a assinatura,
  cancela o original, converte no UNO e baixa o resultado. Em qualquer falha
  devolve o original e mostra notificação.
- `src/content/blob-hook.js` (mundo MAIN): adia `URL.revokeObjectURL` em 60 s
  para dar tempo de ler o PDF gerado como blob.
- `src/content/blob-reader.js`: lê o blob a pedido do service worker.
- `src/content/connect.js`: só na rota `/extensao/conectar` do UNO; recebe o
  token da página e confere o `state` gerado pelo popup.
- `src/popup/`: estado da conexão, cota, liga/desliga por marketplace e as
  últimas conversões (só nome e status; nenhum PDF fica guardado).

## Publicar na Chrome Web Store

1. Conta de desenvolvedor em https://chrome.google.com/webstore/devconsole
   (taxa única de US$ 5, feita pelo dono).
2. Enviar o `.zip` de produção. Ficha: nome, descrição, ícone 128, ao menos
   uma captura 1280×800, categoria "Produtividade".
3. Privacidade: finalidade única ("converter etiquetas de envio de
   marketplaces"); justificar cada permissão:
   - `downloads`: detectar e substituir o arquivo de etiqueta baixado;
   - `tabs`: achar a aba do marketplace que gerou o arquivo;
   - `storage`: guardar o token da conexão e as preferências;
   - `notifications`: avisar quando a conversão falha;
   - hosts: ler o arquivo de etiqueta nos domínios dos marketplaces e falar com
     o UNO.
   Dados tratados: o arquivo da etiqueta (contém nome e endereço do comprador),
   enviado só ao UNO para converter. Precisa apontar para `/privacy`.
4. Depois de aprovada, colocar o link em `UNO_EXTENSION_STORE_URL` no serviço
   `uno` do Easypanel: a página `/dashboard/extensao` passa a mostrar
   "Instalar a extensão".

## Estado

Verificado: testes de unidade das regras de captura e dos tokens no servidor;
`build.mjs` gera os dois pacotes.

**Não verificado:** a captura nos painéis reais do ML, da Shopee e do TikTok
(precisa de conta de vendedor logada e etiqueta real). Pontos a conferir
nessa prova:

- se o ML entrega a etiqueta por URL que aceita um segundo `GET` com o cookie
  (se for `POST`, a extensão deixa o download original passar);
- se a Shopee e o TikTok baixam por blob, por URL assinada de CDN ou por outro
  domínio fora de `src/marketplaces.js`;
- se o download do TikTok traz só etiquetas (a NF-e em download separado ainda
  não é juntada).
