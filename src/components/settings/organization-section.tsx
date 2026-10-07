"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, Input, LoadingState } from "@/components/ui";
import { organizationListSchema, ROLE_LABELS, type MembershipRole, type OrganizationList } from "@/lib/management-model";

import { errorMessage, requestJson } from "./request";

const sectionClass = "rounded-2xl border border-white/10 bg-[#080808] p-6";

export function OrganizationSection({ organizationId, organizationName, role }: { organizationId: string; organizationName: string; role: MembershipRole }) {
  const router = useRouter();
  const [organizations, setOrganizations] = useState<OrganizationList>();
  const [loadError, setLoadError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [name, setName] = useState(organizationName);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const lock = useRef(false);
  const canRename = role !== "MEMBER";

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const body = organizationListSchema.parse(await requestJson("/api/dashboard/organizations", { signal: abort.signal }));
        if (!abort.signal.aborted) { setOrganizations(body); setLoadError(undefined); }
      } catch (cause) {
        if (!abort.signal.aborted) setLoadError(errorMessage(cause, "Não foi possível consultar suas organizações."));
      }
    })();
    return () => abort.abort();
  }, [refresh]);

  const run = async (action: () => Promise<string | undefined>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage(undefined);
    try {
      const text = await action();
      if (text) setMessage({ kind: "ok", text });
    } catch (cause) {
      setMessage({ kind: "error", text: errorMessage(cause) });
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  const rename = () => run(async () => {
    await requestJson(`/api/dashboard/organizations/${organizationId}`, { method: "PATCH", body: { name: name.trim() } });
    setRefresh((value) => value + 1);
    router.refresh();
    return "Nome atualizado.";
  });

  const select = (id: string) => run(async () => {
    await requestJson(`/api/dashboard/organizations/${id}/select`, { method: "POST" });
    // The whole dashboard depends on the selected organization: re-render it on the server.
    setRefresh((value) => value + 1);
    router.refresh();
    return undefined;
  });

  const create = () => run(async () => {
    await requestJson("/api/dashboard/organizations", { method: "POST", body: { name: newName.trim() } });
    setNewName("");
    setRefresh((value) => value + 1);
    router.refresh();
    return "Organização criada e selecionada.";
  });

  return (
    <>
      <section className={sectionClass} aria-labelledby="organization-name-title">
        <h2 id="organization-name-title" className="font-heading text-xl font-semibold">Organização</h2>
        <p className="mt-2 text-sm text-zinc-400">Seu papel aqui: {ROLE_LABELS[role]}.{canRename ? "" : " Apenas o proprietário ou um administrador altera o nome."}</p>
        <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
          <label className="min-w-0 flex-1 text-sm text-zinc-400">Nome da organização
            <Input className="mt-2" value={name} minLength={2} maxLength={80} required disabled={busy || !canRename} onChange={(event) => setName(event.target.value)} />
          </label>
          {canRename ? <Button type="submit" disabled={busy || name.trim().length < 2 || name.trim() === organizationName}>{busy ? "Aguarde…" : "Salvar nome"}</Button> : null}
        </form>
        {message ? <p role={message.kind === "error" ? "alert" : "status"} className={`mt-4 text-sm ${message.kind === "error" ? "text-red-300" : "text-emerald-300"}`}>{message.text}</p> : null}
      </section>

      <section className={sectionClass} aria-labelledby="organization-switch-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="organization-switch-title" className="font-heading text-xl font-semibold">Suas organizações</h2>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Atualizar</Button>
        </div>
        <p className="mt-2 text-sm text-zinc-400">Histórico, cota, chaves e assinatura pertencem à organização selecionada.</p>
        {loadError ? <p role="alert" className="mt-5 text-sm text-red-300">{loadError}</p> : !organizations ? <LoadingState label="Consultando organizações" /> : (
          <ul className="mt-5 divide-y divide-white/10 rounded-xl border border-white/10">
            {organizations.items.map((item) => {
              const current = item.id === organizationId;
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="mt-1 text-xs text-zinc-500">{ROLE_LABELS[item.role]} · Plano {item.planId.charAt(0) + item.planId.slice(1).toLowerCase()}</p>
                  </div>
                  {current ? <span className="rounded-full border border-uno-red/30 bg-uno-red/10 px-3 py-1 text-xs font-semibold text-[#ff6b7e]">Selecionada</span>
                    : <Button variant="secondary" size="sm" disabled={busy} aria-label={`Usar a organização ${item.name}`} onClick={() => void select(item.id)}>Usar esta</Button>}
                </li>
              );
            })}
          </ul>
        )}
        <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label className="min-w-0 flex-1 text-sm text-zinc-400">Nova organização
            <Input className="mt-2" value={newName} minLength={2} maxLength={80} placeholder="Filial, marca ou operação" disabled={busy} onChange={(event) => setNewName(event.target.value)} />
          </label>
          <Button type="submit" variant="secondary" disabled={busy || newName.trim().length < 2}>Criar organização</Button>
        </form>
        <p className="mt-3 text-xs text-zinc-500">A nova organização começa no plano Free, com você como proprietário.</p>
      </section>
    </>
  );
}
