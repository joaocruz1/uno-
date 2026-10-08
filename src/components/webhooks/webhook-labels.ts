import type { WebhookDelivery, WebhookEventType } from "@/lib/webhook-model";

export const eventLabels: Record<WebhookEventType, string> = {
  "conversion.completed": "Conversão concluída",
  "conversion.failed": "Conversão com falha",
  "batch.completed": "Lote finalizado",
};

export const deliveryStatusLabels: Record<WebhookDelivery["status"], string> = {
  pending: "Aguardando envio",
  processing: "Enviando",
  delivered: "Entregue",
  failed: "Falhou",
  canceled: "Cancelada",
};

const deliveryErrorLabels: Record<string, string> = {
  http_status: "O destino não respondeu com sucesso",
  timeout: "Tempo de resposta esgotado",
  network_error: "Falha de conexão",
  tls_error: "Falha no certificado TLS",
  dns_failed: "Endereço não encontrado",
  destination_not_allowed: "Destino não permitido",
  invalid_url: "URL inválida",
  lease_expired: "Tentativa interrompida",
  secret_unavailable: "Segredo indisponível",
  endpoint_disabled: "Endpoint desativado",
  plan_required: "Sem o adicional de API",
};

export function deliveryErrorLabel(code: string | null): string {
  return code ? deliveryErrorLabels[code] ?? "Falha no envio" : "—";
}

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }) : "—";
}
