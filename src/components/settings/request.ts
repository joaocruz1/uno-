export class RequestError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number, readonly fields: string[] = []) {
    super(message);
    this.name = "RequestError";
  }
}

const FALLBACK = "Não foi possível concluir a solicitação. Tente novamente.";

/** Same-origin JSON request that surfaces the API's safe pt-BR message. */
export async function requestJson(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      cache: "no-store",
      signal: init.signal,
      ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new RequestError("Sem conexão com o servidor. Verifique sua rede e tente novamente.");
  }
  if (response.status === 204) return undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: unknown; message?: unknown; details?: { fields?: unknown } } } | undefined)?.error;
    const fields = Array.isArray(error?.details?.fields) ? error.details.fields.filter((field): field is string => typeof field === "string") : [];
    throw new RequestError(typeof error?.message === "string" ? error.message : FALLBACK, typeof error?.code === "string" ? error.code : undefined, response.status, fields);
  }
  return body;
}

export function errorMessage(cause: unknown, fallback = FALLBACK): string {
  return cause instanceof RequestError ? cause.message : fallback;
}

export function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";
}

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—";
}
