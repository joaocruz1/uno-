import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { and, desc, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { conversions, getDb, templates, type UnoDatabase } from "@/db";
import { requiredEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import {
  historyListSchema,
  historyQuerySchema,
  type HistoryList,
  type HistoryQuery,
} from "@/lib/history-model";

const cursorPayloadSchema = z.object({
  v: z.literal(1),
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
  filters: z.string().regex(/^[0-9a-f]{64}$/),
});

type HistoryDependencies = {
  database: UnoDatabase;
  cursorSecret: string;
  now(): Date;
};

function defaults(): HistoryDependencies {
  return { database: getDb(), cursorSecret: requiredEnv("BETTER_AUTH_SECRET"), now: () => new Date() };
}

function filterFingerprint(query: HistoryQuery): string {
  return createHash("sha256").update(JSON.stringify({
    q: query.q ?? null,
    status: query.status ?? null,
    source: query.source ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
  })).digest("hex");
}

function signCursor(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function encodeCursor(createdAt: Date, id: string, query: HistoryQuery, secret: string): string {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    createdAt: createdAt.toISOString(),
    id,
    filters: filterFingerprint(query),
  })).toString("base64url");
  return `${payload}.${signCursor(payload, secret)}`;
}

function decodeCursor(value: string, query: HistoryQuery, secret: string): { createdAt: Date; id: string } {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) throw new AppError("invalid_cursor", "Cursor inválido.", 400);
  const expected = signCursor(encoded, secret);
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new AppError("invalid_cursor", "Cursor inválido.", 400);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new AppError("invalid_cursor", "Cursor inválido.", 400);
  }
  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success || parsed.data.filters !== filterFingerprint(query)) {
    throw new AppError("invalid_cursor", "Cursor inválido para estes filtros.", 400);
  }
  return { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id };
}

export async function listConversionHistory(
  organizationId: string,
  rawQuery: unknown,
  dependencies: HistoryDependencies = defaults(),
): Promise<HistoryList> {
  const query = historyQuerySchema.parse(rawQuery);
  const conditions: SQL[] = [
    eq(conversions.organizationId, organizationId),
    sql`${conversions.status} not in ('deleting', 'deleted')`,
  ];
  if (query.q) {
    conditions.push(sql`strpos(lower(coalesce(${conversions.originalFileName}, '')), lower(${query.q})) > 0`);
  }
  if (query.status) conditions.push(eq(conversions.status, query.status));
  if (query.source) conditions.push(eq(conversions.source, query.source));
  if (query.from) conditions.push(gte(conversions.createdAt, new Date(query.from)));
  if (query.to) conditions.push(lt(conversions.createdAt, new Date(query.to)));
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor, query, dependencies.cursorSecret);
    conditions.push(or(
      lt(conversions.createdAt, cursor.createdAt),
      and(eq(conversions.createdAt, cursor.createdAt), lt(conversions.id, cursor.id)),
    )!);
  }

  const rows = await dependencies.database.select({
    id: conversions.id,
    originalFileName: conversions.originalFileName,
    status: conversions.status,
    progress: conversions.progress,
    templateKey: templates.key,
    templateVersion: conversions.templateVersion,
    outputPreset: conversions.outputPreset,
    outputWidthMm: conversions.outputWidthMm,
    outputHeightMm: conversions.outputHeightMm,
    source: conversions.source,
    inputSha256: conversions.inputSha256,
    outputObjectKey: conversions.outputObjectKey,
    createdAt: conversions.createdAt,
    completedAt: conversions.completedAt,
    artifactsExpireAt: conversions.artifactsExpireAt,
  }).from(conversions).innerJoin(templates, eq(templates.id, conversions.templateId))
    .where(and(...conditions))
    .orderBy(desc(conversions.createdAt), desc(conversions.id))
    .limit(query.limit + 1);

  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const now = dependencies.now();
  return historyListSchema.parse({
    items: page.map((row) => {
      const retained = Boolean(row.artifactsExpireAt && row.artifactsExpireAt > now);
      const terminal = row.status === "completed" || row.status === "failed";
      return {
        id: row.id,
        originalFileName: row.originalFileName,
        status: row.status,
        progress: row.progress,
        template: `${row.templateKey}@${row.templateVersion}`,
        size: {
          preset: row.outputPreset,
          widthMm: Number(row.outputWidthMm),
          heightMm: Number(row.outputHeightMm),
        },
        source: row.source,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        artifactsExpireAt: row.artifactsExpireAt?.toISOString() ?? null,
        canDownload: row.status === "completed" && retained && Boolean(row.outputObjectKey),
        canReprocess: terminal && retained && Boolean(row.inputSha256),
      };
    }),
    nextCursor: hasNextPage && page.length > 0
      ? encodeCursor(page.at(-1)!.createdAt, page.at(-1)!.id, query, dependencies.cursorSecret)
      : null,
  });
}

export type { HistoryDependencies };
