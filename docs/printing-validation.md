# Prova física de impressão

Este protocolo é separado da validação automática. Um PDF que passa na
renderização e decodificação a 203/300 dpi ainda exige prova na impressora
utilizada antes de liberar uma combinação template/tamanho em produção.

## Arquivos fornecidos pela engenharia

- Fixture sintética de entrada com um par etiqueta + DANFE, sem dados reais.
- PDF composto, com uma página e dimensões físicas identificadas.
- Relatório automático: versões da engine/template, tamanho, manifesto de
  conteúdo/geometria, comparação de pixels a 203 dpi e igualdade dos códigos a
  203 e 300 dpi. Os valores esperados são exclusivamente sintéticos.
- Identificador único da execução e hashes SHA-256 de entrada, saída e relatório.
- Cada execução fornece uma variante escolhida; gerar também as variantes com
  informações adicionais preenchidas e escaneada.

O comando exige dimensões explícitas. Estes comandos tentam gerar candidatos
em 100 × 150 mm; se a composição for insuficiente, não haverá pacote final.
Escolher um tamanho maior explicitamente e repetir as três variantes quando
necessário. Um erro de composição não equivale a reprovação de uma impressora.

```sh
pnpm proof:print --width 100 --height 150
pnpm proof:print --width 100 --height 150 --additional
pnpm proof:print --width 100 --height 150 --scanned
```

Os pacotes únicos ficam em `.tmp/print-proof/`, fora do Git. A variante escaneada
exige Tesseract com os idiomas português e inglês configurados localmente.

Nunca usar o PDF real de um cliente em um artefato público ou relatório
versionado. A engenharia mantém o original privado e os testes sintéticos no
repositório.

## Procedimento do operador

1. Registrar hashes/execução do pacote, tolerância dimensional aceita antes do
   ensaio, fabricante, modelo, firmware, resolução (203 ou 300 dpi), sistema,
   driver e largura/altura do papel. Utilizar mídia e ribbon compatíveis.
2. Imprimir a 100% / tamanho real. Desativar ajustar à página, encolher, escala
   automática e margens adicionais do driver. Confirmar que o papel tem o
   tamanho do PDF.
3. Medir a página e as regiões dos códigos com régua. Registrar eventual
   tolerância observada e verificar ausência de cortes, sobreposição e texto
   fiscal perdido. Conferir as áreas adicionais preenchidas.
4. Registrar fabricante/modelo/configuração do leitor. Ler cada CODE128 e QR
   em três impressões independentes e anotar cada resultado. Comparar com
   `syntheticExpectedCodes` do relatório automático correspondente.
5. Registrar todos os resultados. Reprovar qualquer código não lido, diferença
   de conteúdo, corte ou texto inadequado para a operação.
6. Um administrador revisa a evidência e libera somente a combinação testada.
   Mudança de layout, escala, versão ou características relevantes requer nova
   prova. Não extrapolar a aprovação para outro tamanho.

## Registro mínimo

```json
{
  "runId": "Copiar do relatório automático",
  "fixture": "synthetic-pdf-v1",
  "inputSha256": "Copiar do relatório automático",
  "outputSha256": "Copiar do relatório automático",
  "automaticReportSha256": "Copiar do arquivo automatic.sha256",
  "template": "mercado-livre",
  "templateVersion": "1.0.0",
  "engineVersion": "0.1.0",
  "widthMm": 100,
  "heightMm": 150,
  "dpi": 203,
  "printer": "Preencher fabricante/modelo/firmware",
  "driver": "Preencher sistema/driver/configurações",
  "scalePercent": 100,
  "acceptedDimensionToleranceMm": null,
  "measuredWidthMm": null,
  "measuredHeightMm": null,
  "noClipping": false,
  "contentPreserved": false,
  "scanner": "Preencher fabricante/modelo/configuração",
  "codes": [
    { "role": "logistics_barcode", "format": "CODE_128", "measuredWidthMm": null, "measuredHeightMm": null, "readings": [null, null, null], "allThreeMatchExpected": false },
    { "role": "logistics_qr", "format": "QR_CODE", "measuredWidthMm": null, "measuredHeightMm": null, "readings": [null, null, null], "allThreeMatchExpected": false },
    { "role": "danfe_barcode", "format": "CODE_128", "measuredWidthMm": null, "measuredHeightMm": null, "readings": [null, null, null], "allThreeMatchExpected": false }
  ],
  "operator": "Preencher operador responsável",
  "testedAt": null,
  "approvedBy": null,
  "approvedAt": null
}
```

O exemplo é um formulário vazio, não evidência de aprovação. Não existe prova
física concluída neste projeto até o operador preencher e registrar o ensaio.
