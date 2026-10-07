import { and, asc, eq, sql } from "drizzle-orm";

import { conversions, getDb, processingEvents, templates, type UnoDatabase } from "@/db";
import type { ConversionView } from "@/lib/conversion-model";
import { AppError } from "@/lib/errors";
import { outputSizeSchema } from "@/lib/label-size";
import { getStorage, type StorageGateway } from "@/server/storage";

type ReadDependencies = {
  database: Pick<UnoDatabase, "select">;
  storage: StorageGateway;
  now(): Date;
};

function defaults(): ReadDependencies {
  return { database: getDb(), storage: getStorage(), now: () => new Date() };
}

function suggestedSize(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = outputSizeSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function readConversion(
  organizationId: string,
  conversionId: string,
  dependencies: ReadDependencies = defaults(),
): Promise<ConversionView> {
  const rows = await dependencies.database.select({
    id: conversions.id,
    status: conversions.status,
    progress: conversions.progress,
    stage: conversions.currentStage,
    templateKey: templates.key,
    templateVersion: conversions.templateVersion,
    engineVersion: conversions.engineVersion,
    outputPreset: conversions.outputPreset,
    outputWidthMm: conversions.outputWidthMm,
    outputHeightMm: conversions.outputHeightMm,
    originalFileName: conversions.originalFileName,
    inputObjectKey: conversions.inputObjectKey,
    outputObjectKey: conversions.outputObjectKey,
    createdAt: conversions.createdAt,
    completedAt: conversions.completedAt,
    artifactsExpireAt: conversions.artifactsExpireAt,
    processingTimeMs: conversions.processingTimeMs,
    errorCode: conversions.errorCode,
    errorMessage: conversions.errorMessage,
    suggestedSize: conversions.suggestedSize,
  }).from(conversions).innerJoin(templates, eq(templates.id, conversions.templateId))
    .where(and(eq(conversions.organizationId, organizationId), eq(conversions.id, conversionId), sql`${conversions.status} not in ('deleting', 'deleted')`))
    .limit(1);
  const conversion = rows[0];
  if (!conversion || !["queued", "processing", "completed", "failed"].includes(conversion.status)) {
    throw new AppError("not_found", "Conversão não encontrada.", 404);
  }
  const events = await dependencies.database.select({
    stage: processingEvents.stage,
    progress: processingEvents.progress,
    createdAt: processingEvents.createdAt,
  }).from(processingEvents).where(and(
    eq(processingEvents.organizationId, organizationId),
    eq(processingEvents.conversionId, conversionId),
  )).orderBy(asc(processingEvents.createdAt));

  const initialRemainingMs = conversion.artifactsExpireAt
    ? conversion.artifactsExpireAt.getTime() - dependencies.now().getTime()
    : 0;
  const canDownload = conversion.status === "completed" && conversion.outputObjectKey && initialRemainingMs >= 1_000;
  let signed: Awaited<ReturnType<StorageGateway["signDownload"]>>[] | undefined;
  if (canDownload) {
    try {
      const [outputHead, inputHead] = await Promise.all([
        dependencies.storage.head(conversion.outputObjectKey as string),
        dependencies.storage.head(conversion.inputObjectKey),
      ]);
      if (outputHead.contentLength < 1 || inputHead.contentLength < 1) {
        throw new AppError("artifact_unavailable", "Os arquivos desta conversão não estão disponíveis.", 410);
      }
      const remainingMs = conversion.artifactsExpireAt
        ? conversion.artifactsExpireAt.getTime() - dependencies.now().getTime()
        : 0;
      if (remainingMs < 1_000) {
        signed = undefined;
      } else {
      const expiresInSeconds = Math.min(300, Math.floor(remainingMs / 1_000));
      signed = await Promise.all([
        dependencies.storage.signDownload(conversion.outputObjectKey as string, expiresInSeconds),
        dependencies.storage.signDownload(conversion.inputObjectKey, expiresInSeconds),
      ]);
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "upload_not_found") {
        throw new AppError("artifact_unavailable", "Os arquivos desta conversão não estão disponíveis.", 410);
      }
      throw error;
    }
  }
  return {
    id: conversion.id,
    status: conversion.status as "queued" | "processing" | "completed" | "failed",
    progress: conversion.progress,
    ...(conversion.stage ? { stage: conversion.stage } : {}),
    template: `${conversion.templateKey}@${conversion.templateVersion}`,
    engineVersion: conversion.engineVersion,
    size: {
      preset: conversion.outputPreset as "100x150" | "100x100" | "a6" | "custom",
      widthMm: Number(conversion.outputWidthMm),
      heightMm: Number(conversion.outputHeightMm),
    },
    originalFileName: conversion.originalFileName,
    createdAt: conversion.createdAt.toISOString(),
    completedAt: conversion.completedAt?.toISOString() ?? null,
    artifactsExpireAt: conversion.artifactsExpireAt?.toISOString() ?? null,
    processingTimeMs: conversion.processingTimeMs,
    ...(signed ? {
      download: { url: signed[0].url, expiresAt: signed[0].expiresAt.toISOString() },
      original: { url: signed[1].url, expiresAt: signed[1].expiresAt.toISOString() },
    } : {}),
    ...(conversion.status === "failed" && conversion.errorCode && conversion.errorMessage ? {
      error: {
        code: conversion.errorCode,
        message: conversion.errorMessage,
        ...(suggestedSize(conversion.suggestedSize) ? { suggestedSize: suggestedSize(conversion.suggestedSize) } : {}),
      },
    } : {}),
    events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
  };
}

export type { ReadDependencies };
