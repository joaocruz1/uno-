import { createHash } from "node:crypto";

import { EngineError } from "@/engine/errors";
import type { ConversionResult, OutputSize } from "@/engine/types";
import { positiveIntegerEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { assertTemplateEligible, findTemplate, INITIAL_TEMPLATE, seedInitialDraftTemplate } from "@/server/conversions/templates";
import { enforceRateLimit } from "@/server/rate-limit";
import { getRedis } from "@/server/redis";

/**
 * Anonymous one-time demo for the landing page. Nothing is stored: the PDF is
 * converted in memory and returned in the same response. "Once" is enforced by
 * a cookie and by a hashed network address; it deters casual reuse and is not
 * an identity guarantee.
 */
export const TRIAL_COOKIE = "uno_trial_used";
export const TRIAL_MAX_BYTES = 5 * 1_024 * 1_024;
const TRIAL_SIZE: OutputSize = { preset: "100x150" };
const TRIAL_TTL_SECONDS = 30 * 86_400;
const MULTIPART_OVERHEAD_BYTES = 64 * 1_024;

export interface TrialStore {
  isUsed(key: string): Promise<boolean>;
  markUsed(key: string, ttlSeconds: number): Promise<void>;
}

export type TrialDependencies = {
  store: TrialStore;
  convert(bytes: Uint8Array, size: OutputSize): Promise<ConversionResult>;
  assertAvailable(): Promise<void>;
  limit(namespace: string, identifier: string, limit: number, windowSeconds: number): Promise<void>;
  secret(): string;
};

let active = 0;

function defaults(): TrialDependencies {
  return {
    store: {
      async isUsed(key) { return (await getRedis().exists(`uno:trial:used:${key}`)) === 1; },
      async markUsed(key, ttlSeconds) { await getRedis().set(`uno:trial:used:${key}`, "1", "EX", ttlSeconds); },
    },
    async convert(bytes, size) {
      const { convertPdf } = await import("@/engine");
      return convertPdf(bytes, size);
    },
    async assertAvailable() {
      if (process.env.NODE_ENV !== "production" && process.env.UNO_ALLOW_DRAFT_TEMPLATES === "true") await seedInitialDraftTemplate();
      assertTemplateEligible(await findTemplate(INITIAL_TEMPLATE), TRIAL_SIZE);
    },
    limit: (namespace, identifier, limit, windowSeconds) => enforceRateLimit({ namespace, identifier, limit, windowSeconds }),
    secret: () => process.env.BETTER_AUTH_SECRET ?? "",
  };
}

function cookieUsed(headers: Headers): boolean {
  return (headers.get("cookie") ?? "").split(";").some((part) => part.trim() === `${TRIAL_COOKIE}=1`);
}

/** Never stores the address itself; only a keyed digest that expires. */
export function trialVisitorKey(headers: Headers, secret: string): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(`${secret}:trial:${address}`, "utf8").digest("hex").slice(0, 40);
}

export function trialCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${TRIAL_COOKIE}=1; Path=/; Max-Age=${TRIAL_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

export async function trialAvailable(headers: Headers, dependencies: TrialDependencies = defaults()): Promise<boolean> {
  if (cookieUsed(headers)) return false;
  try {
    return !await dependencies.store.isUsed(trialVisitorKey(headers, dependencies.secret()));
  } catch {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
}

async function readBounded(request: Request): Promise<Uint8Array> {
  const limit = TRIAL_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new AppError("file_too_large", "O teste aceita PDFs de até 5 MB.", 413);
  if (!request.body) throw new AppError("invalid_request", "Envie um arquivo PDF.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      throw new AppError("file_too_large", "O teste aceita PDFs de até 5 MB.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

async function readPdf(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw new AppError("invalid_request", "Envie um arquivo PDF.", 400);
  const body = await readBounded(request);
  let file: FormDataEntryValue | null;
  try {
    file = (await new Response(Buffer.from(body), { headers: { "content-type": contentType } }).formData()).get("file");
  } catch {
    throw new AppError("invalid_request", "Envie um arquivo PDF.", 400);
  }
  if (!(file instanceof File) || file.size < 1) throw new AppError("invalid_request", "Envie um arquivo PDF.", 400);
  if (file.size > TRIAL_MAX_BYTES) throw new AppError("file_too_large", "O teste aceita PDFs de até 5 MB.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!Buffer.from(bytes.subarray(0, 1_024)).includes("%PDF-")) throw new AppError("invalid_pdf", "O arquivo enviado não é um PDF válido.", 422);
  return bytes;
}

export async function runPublicTrial(request: Request, dependencies: TrialDependencies = defaults()): Promise<Uint8Array> {
  const headers = new Headers(request.headers);
  const visitor = trialVisitorKey(headers, dependencies.secret());
  // Attempts are limited separately from the single success, so a failed file can be retried a few times.
  await dependencies.limit("public-trial", visitor, positiveIntegerEnv("UNO_TRIAL_ATTEMPTS_PER_HOUR", 6), 3_600);
  await dependencies.limit("public-trial-global", "all", positiveIntegerEnv("UNO_TRIAL_GLOBAL_PER_MINUTE", 30), 60);
  if (!await trialAvailable(headers, dependencies)) {
    throw new AppError("trial_used", "Você já usou o teste gratuito. Crie uma conta para continuar.", 403);
  }
  await dependencies.assertAvailable();
  const bytes = await readPdf(request);
  if (active >= positiveIntegerEnv("UNO_TRIAL_CONCURRENCY", 2)) {
    throw new AppError("rate_limit_exceeded", "Muitas pessoas testando agora. Tente novamente em instantes.", 429, { retryAfterSeconds: 10 });
  }
  active += 1;
  let result: ConversionResult;
  try {
    result = await dependencies.convert(bytes, TRIAL_SIZE);
  } catch (error) {
    if (error instanceof EngineError) throw new AppError(error.code, error.message, 422);
    throw new AppError("internal_error", "Não foi possível unificar este PDF.", 500);
  } finally {
    active -= 1;
  }
  await dependencies.store.markUsed(visitor, TRIAL_TTL_SECONDS).catch(() => undefined);
  return result.bytes;
}
