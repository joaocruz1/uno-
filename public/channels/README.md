# Logos oficiais dos marketplaces

Coloque aqui o SVG (ou PNG) oficial de cada canal, com o nome exato abaixo. No
instante em que o arquivo existir, o componente `ChannelMark`
(`src/components/marketplace-logos.tsx`) troca a marca-sigla (ML, SH, …) pelo
logo real automaticamente — na landing, na home do painel e no conversor de
lote. Não é preciso mexer no código.

| Arquivo esperado            | Marca          |
| --------------------------- | -------------- |
| `mercado-livre.svg`         | Mercado Livre  |
| `shopee.svg`                | Shopee         |
| `amazon.svg`                | Amazon         |
| `magalu.svg`                | Magalu         |
| `tiktok.svg`                | TikTok Shop    |
| `tray.svg`                  | Tray           |

Observações:
- O logo é exibido num quadrado (quadrado com cantos arredondados). Prefira SVGs
  com fundo transparente e área de respiro já embutida.
- Esses logotipos são marcas registradas de terceiros; a decisão de usá-los e a
  origem dos arquivos é do dono (ex.: Wikimedia Commons), por isso ficam fora do
  Git (este diretório está ignorado, exceto este README).
- Enquanto o arquivo não existir, aparece a marca original da UNO (a sigla de
  duas letras na cor da marca).
