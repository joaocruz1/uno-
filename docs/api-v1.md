# API UNO v1

Base URL: o host configurado em `API_URL`, atendido pelo serviço Docker da API.
A API exige o adicional "+ API" (R$ 50,00/mês), que pode ser contratado em
qualquer plano pago (Starter, Pro ou Business) em Assinatura no painel. Com o
adicional ativo, crie uma chave no painel. Sem ele, ou sem um plano pago
vigente, as chamadas respondem `403 plan_required`. Ela é exibida uma vez; armazene
no cofre de segredos do ERP. Nunca inclua a chave em código de navegador.
Os exemplos usam exclusivamente nomes sintéticos.

## cURL

```bash
export UNO_API_URL="https://api.seu-dominio.example"
# Defina UNO_API_KEY no ambiente seguro do ERP.
curl --fail-with-body "$UNO_API_URL/api/v1/conversions" \
  -H "Authorization: Bearer $UNO_API_KEY" \
  -H "Idempotency-Key: pedido-sintetico-001-v1" \
  -F "file=@synthetic.pdf;type=application/pdf" \
  -F "size=custom" -F "widthMm=100" -F "heightMm=250"

curl --fail-with-body "$UNO_API_URL/api/v1/conversions/ID_RETORNADO" \
  -H "Authorization: Bearer $UNO_API_KEY"

curl --fail-with-body "$UNO_API_URL/api/v1/batches" \
  -H "Authorization: Bearer $UNO_API_KEY" \
  -H "Idempotency-Key: lote-sintetico-001-v1" \
  -F "files=@synthetic-a.pdf;type=application/pdf" \
  -F "files=@synthetic-b.pdf;type=application/pdf" \
  -F "size=custom" -F "widthMm=100" -F "heightMm=250"

curl --fail-with-body "$UNO_API_URL/api/v1/usage" \
  -H "Authorization: Bearer $UNO_API_KEY"
```

## JavaScript em serviço do ERP

```js
async function convertPdf(pdfBlob, apiUrl, apiKey, operationKey) {
  const form = new FormData();
  form.append("file", pdfBlob, "synthetic.pdf");
  form.append("size", "custom");
  form.append("widthMm", "100");
  form.append("heightMm", "250");
  const response = await fetch(`${apiUrl}/api/v1/conversions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Idempotency-Key": operationKey },
    body: form,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error.code}: ${result.requestId}`);
  return result; // HTTP 202: processamento assíncrono
}
```

Não defina Content-Type manualmente para FormData: o runtime inclui o boundary.
Reutilize a mesma chave da operação ao repetir uma requisição cujo resultado se
perdeu. Novos parâmetros com a mesma chave retornam 409; uma nova operação
deliberada usa outra chave.

## Node.js 24

```js
import { openAsBlob } from "node:fs";
import { randomUUID } from "node:crypto";

const apiUrl = process.env.UNO_API_URL;
const apiKey = process.env.UNO_API_KEY;
const body = new FormData();
body.append("file", await openAsBlob("synthetic.pdf", { type: "application/pdf" }), "synthetic.pdf");
body.append("size", "custom"); body.append("widthMm", "100"); body.append("heightMm", "250");
const operationKey = randomUUID(); // persista esta chave junto à operação
const response = await fetch(`${apiUrl}/api/v1/conversions`, {
  method: "POST", body,
  headers: { Authorization: `Bearer ${apiKey}`, "Idempotency-Key": operationKey },
});
const accepted = await response.json();
if (response.status !== 202) throw new Error(`${accepted.error.code}: ${accepted.requestId}`);
// Consulte GET /api/v1/conversions/{id} ou receba o webhook.
```

## Python

```python
import os
import uuid
import requests

base = os.environ["UNO_API_URL"]
headers = {
    "Authorization": f"Bearer {os.environ['UNO_API_KEY']}",
    "Idempotency-Key": str(uuid.uuid4()),  # persista para retries
}
with open("synthetic.pdf", "rb") as pdf:
    response = requests.post(
        f"{base}/api/v1/conversions", headers=headers,
        files={"file": ("synthetic.pdf", pdf, "application/pdf")},
        data={"size": "custom", "widthMm": "100", "heightMm": "250"},
        timeout=(10, 180),
    )
response.raise_for_status()
conversion = response.json()
status = requests.get(
    f"{base}/api/v1/conversions/{conversion['id']}",
    headers={"Authorization": headers["Authorization"]}, timeout=20,
)
status.raise_for_status()
```

## Consulta, arquivos e erros

GET conversão retorna queued/processing/completed/failed e progresso persistido.
Em completed, `download.url` tem validade curta; obtenha outro link pela consulta
se expirar. URLs são privadas e não devem entrar em logs. GET lote inclui
contadores/itens e ZIP dos resultados aprovados. Falhas individuais não consomem
cota; successful outputs confirmam uma unidade cada. GET usage retorna período,
limit/reserved/confirmed/remaining.

O limite é compartilhado por organização: Pro 60/min e Business 120/min nos
padrões iniciais. Em 429, respeite Retry-After. Em falha de rede/5xx, faça retry
com backoff e a mesma chave idempotente. Erros 4xx normalmente exigem correção;
format_too_small requer um formato que preserve a legibilidade e esteja liberado.

100×250 mm nos exemplos é candidato de desenvolvimento. Cada combinação
template/tamanho precisa de liberação antes do uso em produção.

## Receber webhooks

Verifique o corpo original antes de interpretar JSON. A assinatura é
HMAC-SHA-256(secret, timestamp + "." + rawBody), enviada como `v1=hex` em
X-Label-Signature. X-Label-Timestamp está em segundos Unix; rejeite timestamps
fora da janela escolhida (por exemplo cinco minutos), compare assinatura em
tempo constante e deduplique X-Label-Delivery antes do efeito de negócio.

Eventos: conversion.completed, conversion.failed, batch.completed. O último
inclui status final e contadores, incluindo lotes parcialmente aprovados ou sem
saída. Responda 2xx após aceitar duravelmente o evento. Falhas recebem cinco
retries após 1 min, 5 min, 30 min, 2 h e 12 h. Não registre corpo, assinatura,
segredo ou URLs privadas.

O contrato completo está em `specs/03-contracts/public-api-v1.md`.

## Guia do receptor de webhooks

Cada entrega é um POST HTTPS com `Content-Type: application/json` e três
cabeçalhos:

| Cabeçalho | Conteúdo |
| --- | --- |
| `X-Label-Timestamp` | Momento do envio em segundos Unix. Muda a cada tentativa. |
| `X-Label-Delivery` | Identificador da entrega. É o mesmo em todas as tentativas. |
| `X-Label-Signature` | `v1=` seguido do HMAC-SHA-256 em hexadecimal minúsculo. |

O corpo tem sempre `id`, `type`, `createdAt`, `organizationId` e `data`, e é
idêntico byte a byte em todas as tentativas da mesma entrega. `data` traz apenas
identificadores, estado, contadores e, em falhas, `error.code`/`error.message`.
Para obter o arquivo, consulte a conversão ou o lote pela API com sua chave.

```json
{
  "id": "5d0c7c0e-6f2b-4b7e-9a51-1f1f0c3a9d10",
  "type": "batch.completed",
  "createdAt": "2026-10-07T12:00:00.000Z",
  "organizationId": "0b6f3c1a-2d4e-4f5a-8b9c-0d1e2f3a4b5c",
  "data": {
    "batchId": "7a1e9c52-3b4d-4c6f-8e2a-9b0c1d2e3f40",
    "status": "completed",
    "counts": { "completed": 48, "failed": 2 }
  }
}
```

### Verificar a assinatura

A chave do HMAC é o segredo `whsec_...` exibido uma única vez na criação do
endpoint, usado como texto UTF-8 (sem decodificar). A mensagem assinada é
`<X-Label-Timestamp>.<corpo bruto>`. Calcule sobre os bytes recebidos, antes de
qualquer `JSON.parse`: reserializar o JSON altera os bytes e invalida a
assinatura. Compare em tempo constante; `==` ou `===` vazam, pelo tempo de
resposta, quantos caracteres iniciais estão corretos.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300;

// rawBody: Buffer com os bytes exatos da requisição.
export function verifyUnoWebhook(rawBody, headers, secret) {
  const timestamp = headers["x-label-timestamp"];
  const signature = headers["x-label-signature"];
  if (!/^[0-9]{1,12}$/.test(timestamp ?? "") || !/^v1=[0-9a-f]{64}$/.test(signature ?? "")) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  const received = Buffer.from(signature.slice(3), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

```python
import hashlib, hmac, re, time

TOLERANCE_SECONDS = 300

def verify_uno_webhook(raw_body: bytes, headers, secret: str) -> bool:
    timestamp = headers.get("X-Label-Timestamp", "")
    signature = headers.get("X-Label-Signature", "")
    if not re.fullmatch(r"[0-9]{1,12}", timestamp) or not signature.startswith("v1="):
        return False
    if abs(time.time() - int(timestamp)) > TOLERANCE_SECONDS:
        return False
    message = timestamp.encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature[3:], expected)
```

### Janela de replay

Rejeite entregas cujo `X-Label-Timestamp` esteja fora de uma janela curta em
relação ao seu relógio; cinco minutos é um valor seguro. O timestamp faz parte
da mensagem assinada, então não pode ser alterado sem invalidar a assinatura.
Mantenha o relógio do servidor sincronizado (NTP). Cada nova tentativa da UNO
leva timestamp e assinatura novos, portanto retries legítimos passam na janela.

### Deduplicação

A entrega é ao menos uma vez: após timeout, queda de rede ou resposta perdida, a
mesma entrega pode chegar de novo. Guarde `X-Label-Delivery` com restrição de
unicidade (por pelo menos 24 horas; as tentativas automáticas se estendem por
cerca de 15 horas) e ignore o que já foi processado, respondendo 2xx. Registre o
identificador e aplique o efeito de negócio na mesma transação. O campo `id` do
corpo identifica o evento e é igual para todos os endpoints inscritos.

### Respostas e tentativas

- Responda 2xx em até 10 segundos, depois de gravar o evento de forma durável;
  processe o restante de forma assíncrona. O corpo da resposta é descartado.
- Qualquer outro código, inclusive 3xx (redirecionamentos não são seguidos),
  timeout ou falha de conexão gera nova tentativa após 1 min, 5 min, 30 min, 2 h
  e 12 h. Depois de seis envios sem sucesso a entrega fica como falha.
- Desativar ou excluir o endpoint, ou perder o adicional de API ou o plano pago, cancela as
  entregas pendentes. Elas não são reenviadas automaticamente na reativação, e
  um endpoint novo não recebe eventos anteriores à sua criação.
- O destino precisa ser HTTPS na porta 443, com certificado válido e nome de
  host público. Endereços internos, privados ou IPs literais são recusados.
- Não registre o segredo, a assinatura nem o corpo completo em logs.

## Cabeçalho de produto (opcional)

Em `POST /api/v1/conversions`, envie os campos abaixo para imprimir uma caixa de
separação acima da etiqueta. O PDF do marketplace não contém esses dados; eles
vêm do seu ERP.

| Campo | Obrigatório | Valor |
| --- | --- | --- |
| `productTitle` | sim, se qualquer campo de produto for enviado | até 140 caracteres |
| `quantity` | não (padrão 1) | inteiro de 1 a 9999; acima de 1 imprime "ATENÇÃO À QUANTIDADE" |
| `sku` | não | até 60 caracteres |
| `variation` | não | até 60 caracteres, por exemplo `Cor: Verde` |

```bash
curl --fail-with-body "$UNO_API_URL/api/v1/conversions" \
  -H "Authorization: Bearer $UNO_API_KEY" \
  -H "Idempotency-Key: pedido-sintetico-002-v1" \
  -F "file=@synthetic.pdf;type=application/pdf" \
  -F "size=100x150" \
  -F "productTitle=Produto sintetico" -F "quantity=2" \
  -F "sku=SKU-SINTETICO-01" -F "variation=Cor: Verde"
```

Os campos fazem parte da identidade idempotente da requisição. `POST
/api/v1/batches` recusa esses campos com 400: os dados são por pedido. Com PDF
digital, a saída padrão de 100 × 150 mm traz cabeçalho (se enviado), etiqueta
logística e a faixa "DANFE SIMPLIFICADA - ETIQUETA" com NF, série, emissão e o
código de barras da chave. Caracteres fora do Latin-1 são omitidos na impressão.
