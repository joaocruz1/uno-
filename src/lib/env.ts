import { z } from "zod";
import { AppError } from "./errors";
export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AppError("service_unavailable", `Configuração de serviço ausente: ${name}.`, 503);
  return value;
}
export function appUrl(): string { return z.url().parse(process.env.APP_URL ?? "http://localhost:3000"); }
export function authEnvironment() {
  return z.object({ secret: z.string().min(32), baseURL: z.url() }).parse({ secret: requiredEnv("BETTER_AUTH_SECRET"), baseURL: process.env.BETTER_AUTH_URL ?? appUrl() });
}
/**
 * Unreleased templates are usable in development with UNO_ALLOW_DRAFT_TEMPLATES.
 * In production the operator can open them as a beta with
 * UNO_ALLOW_UNRELEASED_TEMPLATES=true: an explicit acceptance that labels are
 * issued before the physical print proof exists.
 */
export function allowDraftTemplates(): boolean {
  if (process.env.UNO_ALLOW_UNRELEASED_TEMPLATES === "true") return true;
  return process.env.NODE_ENV !== "production" && process.env.UNO_ALLOW_DRAFT_TEMPLATES === "true";
}
export function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
