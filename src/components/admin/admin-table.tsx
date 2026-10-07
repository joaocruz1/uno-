"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";

import { errorMessage, formatDateTime, requestJson } from "@/components/settings/request";
import { Button, EmptyState, LoadingState, Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import {
  adminConversionPageSchema,
  adminJobPageSchema,
  adminOrganizationPageSchema,
  adminSubscriptionPageSchema,
  adminUsagePageSchema,
  type AdminConversion,
  type AdminJob,
  type AdminOrganization,
  type AdminSubscription,
  type AdminUsage,
} from "@/lib/admin-model";

type Column<Item> = { header: string; cell: (item: Item) => ReactNode };
type Resource<Item extends { id: string }> = {
  schema: z.ZodType<{ items: Item[]; nextCursor: string | null }>;
  empty: [title: string, description: string];
  columns: Array<Column<Item>>;
};

const mono = (value: string | null) => value ? <span className="font-mono text-xs" title={value}>{value.slice(0, 8)}…</span> : "—";
const text = (value: string | number | null) => value ?? "—";
const size = (item: AdminConversion) => `${item.widthMm} × ${item.heightMm} mm`;

const conversionColumns: Array<Column<AdminConversion>> = [
  { header: "Conversão", cell: (item) => mono(item.id) },
  { header: "Organização", cell: (item) => mono(item.organizationId) },
  { header: "Estado", cell: (item) => item.status },
  { header: "Etapa", cell: (item) => text(item.stage) },
  { header: "Erro", cell: (item) => item.errorCode ? <span className="font-mono text-xs text-red-300">{item.errorCode}</span> : "—" },
  { header: "Origem", cell: (item) => item.source },
  { header: "Modelo / engine", cell: (item) => `${item.templateVersion} / ${item.engineVersion}` },
  { header: "Formato", cell: size },
  { header: "Tentativas", cell: (item) => `${item.attempts}/${item.maxAttempts}` },
  { header: "Tempo", cell: (item) => item.processingTimeMs === null ? "—" : `${item.processingTimeMs.toLocaleString("pt-BR")} ms` },
  { header: "Criada em", cell: (item) => formatDateTime(item.createdAt) },
];

const RESOURCES = {
  organizations: {
    schema: adminOrganizationPageSchema,
    empty: ["Nenhuma organização", "As organizações aparecem aqui quando as contas são criadas."],
    columns: [
      { header: "Organização", cell: (item) => mono(item.id) },
      { header: "Nome", cell: (item) => item.name },
      { header: "Proprietário", cell: (item) => mono(item.ownerUserId) },
      { header: "Membros", cell: (item) => item.memberCount },
      { header: "Plano", cell: (item) => text(item.planId) },
      { header: "Assinatura", cell: (item) => text(item.subscriptionStatus) },
      { header: "Criada em", cell: (item) => formatDateTime(item.createdAt) },
    ],
  } satisfies Resource<AdminOrganization>,
  subscriptions: {
    schema: adminSubscriptionPageSchema,
    empty: ["Nenhuma assinatura", "As assinaturas aparecem aqui junto com as organizações."],
    columns: [
      { header: "Organização", cell: (item) => mono(item.organizationId) },
      { header: "Plano", cell: (item) => item.planId },
      { header: "Estado", cell: (item) => item.status },
      { header: "Cobrança vinculada", cell: (item) => item.billingLinked ? "Sim" : "Não" },
      { header: "Período", cell: (item) => item.currentPeriodStart ? `${formatDateTime(item.currentPeriodStart)} → ${formatDateTime(item.currentPeriodEnd)}` : "—" },
      { header: "Cancela ao fim", cell: (item) => item.cancelAtPeriodEnd ? "Sim" : "Não" },
      { header: "Reconciliação", cell: (item) => `v${item.reconciliationVersion} · ${formatDateTime(item.lastReconciledAt)}` },
    ],
  } satisfies Resource<AdminSubscription>,
  usage: {
    schema: adminUsagePageSchema,
    empty: ["Nenhum período de uso", "Os períodos são abertos na primeira conversão de cada ciclo."],
    columns: [
      { header: "Organização", cell: (item) => mono(item.organizationId) },
      { header: "Início", cell: (item) => formatDateTime(item.periodStart) },
      { header: "Fim", cell: (item) => formatDateTime(item.periodEnd) },
      { header: "Limite", cell: (item) => item.limit.toLocaleString("pt-BR") },
      { header: "Reservado", cell: (item) => item.reserved.toLocaleString("pt-BR") },
      { header: "Confirmado", cell: (item) => item.confirmed.toLocaleString("pt-BR") },
    ],
  } satisfies Resource<AdminUsage>,
  conversions: {
    schema: adminConversionPageSchema,
    empty: ["Nenhuma conversão", "As conversões aparecem aqui assim que são aceitas."],
    columns: conversionColumns,
  } satisfies Resource<AdminConversion>,
  failures: {
    schema: adminConversionPageSchema,
    empty: ["Nenhuma falha", "Conversões com falha terminal aparecem aqui com o código de erro."],
    columns: conversionColumns,
  } satisfies Resource<AdminConversion>,
  jobs: {
    schema: adminJobPageSchema,
    empty: ["Nenhum job", "Os eventos do outbox aparecem aqui quando são gerados."],
    columns: [
      { header: "Job", cell: (item) => mono(item.id) },
      { header: "Organização", cell: (item) => mono(item.organizationId) },
      { header: "Tipo", cell: (item) => <span className="font-mono text-xs">{item.type}</span> },
      { header: "Recurso", cell: (item) => <>{item.aggregateType} {mono(item.aggregateId)}</> },
      { header: "Estado", cell: (item) => item.status },
      { header: "Tentativas", cell: (item) => item.attempts },
      { header: "Com erro", cell: (item) => item.hasError ? <span className="text-red-300">Sim</span> : "Não" },
      { header: "Disponível em", cell: (item) => formatDateTime(item.availableAt) },
      { header: "Publicado em", cell: (item) => formatDateTime(item.publishedAt) },
    ],
  } satisfies Resource<AdminJob>,
};

export type AdminResource = keyof typeof RESOURCES;

type Row = { id: string };

export function AdminTable({ resource }: { resource: AdminResource }) {
  const definition = RESOURCES[resource] as unknown as Resource<Row>;
  const [items, setItems] = useState<Row[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const page = definition.schema.parse(await requestJson(`/api/admin/${resource}?limit=25`, { signal: abort.signal }));
        if (!abort.signal.aborted) { setItems(page.items); setNextCursor(page.nextCursor); setError(undefined); }
      } catch (cause) {
        if (!abort.signal.aborted) setError(errorMessage(cause, "Não foi possível consultar os dados."));
      }
    })();
    return () => abort.abort();
  }, [definition, resource, reload]);

  const more = async () => {
    if (!nextCursor || lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const page = definition.schema.parse(await requestJson(`/api/admin/${resource}?limit=25&cursor=${encodeURIComponent(nextCursor)}`));
      setItems((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause, "Não foi possível carregar mais registros."));
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  return (
    <div className="mt-8">
      <div className="flex justify-end"><Button variant="ghost" size="sm" disabled={busy} onClick={() => { setItems(undefined); setReload((value) => value + 1); }}>Atualizar</Button></div>
      {error ? <p role="alert" className="mt-4 text-sm text-red-300">{error}</p> : null}
      {!items ? (error ? null : <LoadingState label="Consultando registros" />) : !items.length ? (
        <div className="mt-4"><EmptyState title={definition.empty[0]} description={definition.empty[1]} /></div>
      ) : (
        <div className="mt-4 rounded-xl border border-white/10">
          <Table className="min-w-[960px]">
            <TableHeader><tr>{definition.columns.map((column) => <TableHead key={column.header} className="whitespace-nowrap">{column.header}</TableHead>)}</tr></TableHeader>
            <tbody>{items.map((item) => <TableRow key={item.id}>{definition.columns.map((column) => <TableCell key={column.header} className="whitespace-nowrap">{column.cell(item)}</TableCell>)}</TableRow>)}</tbody>
          </Table>
        </div>
      )}
      {items?.length ? <div className="mt-5 flex items-center justify-between gap-4"><p className="text-xs text-zinc-500">{items.length.toLocaleString("pt-BR")} registros carregados</p>{nextCursor ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void more()}>{busy ? "Carregando…" : "Carregar mais"}</Button> : <p className="text-xs text-zinc-500">Fim da lista</p>}</div> : null}
    </div>
  );
}
