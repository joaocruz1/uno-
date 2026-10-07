import { AppError } from "@/lib/errors";

export const WEBHOOK_MAX_ATTEMPTS = 6;
/** Delay after attempt N (1-based) fails: 1 min, 5 min, 30 min, 2 h, 12 h. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1_024;
export const WEBHOOK_PORT = 443;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ACTIVE_ENDPOINTS = 10;

/** Security-relevant values fail explicitly instead of silently falling back. */
function boundedIntegerEnv(name: string, fallback: number, min: number, max: number, environment: NodeJS.ProcessEnv): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = /^[1-9][0-9]*$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError("service_unavailable", `Configuração de serviço inválida: ${name}.`, 503);
  }
  return parsed;
}

export function webhookTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  return boundedIntegerEnv("UNO_WEBHOOK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000, 60_000, environment);
}

export function webhookMaxActiveEndpoints(environment: NodeJS.ProcessEnv = process.env): number {
  return boundedIntegerEnv("UNO_WEBHOOK_MAX_ACTIVE_ENDPOINTS", DEFAULT_MAX_ACTIVE_ENDPOINTS, 1, 100, environment);
}
