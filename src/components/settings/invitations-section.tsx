"use client";

import { useEffect, useRef, useState } from "react";

import { Button, Dialog, EmptyState, Input, LoadingState } from "@/components/ui";
import { invitationListSchema, ROLE_LABELS, type AssignableRole, type Invitation, type InvitationList, type MembershipRole } from "@/lib/management-model";

import { errorMessage, formatDate, requestJson } from "./request";

const sectionClass = "rounded-2xl border border-white/10 bg-[#080808] p-6";
const selectClass = "h-11 rounded-lg border border-white/10 bg-[#0d0d0d] px-3 text-sm text-white outline-none focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 disabled:opacity-50";
const STATUS_LABELS: Record<Invitation["status"], string> = { PENDING: "Pendente", EXPIRED: "Expirado", ACCEPTED: "Aceito", REVOKED: "Revogado" };

export function InvitationsSection({ organizationId, role }: { organizationId: string; role: MembershipRole }) {
  const [invitations, setInvitations] = useState<InvitationList>();
  const [loadError, setLoadError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AssignableRole>("MEMBER");
  const [revoke, setRevoke] = useState<Invitation>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const lock = useRef(false);
  const base = `/api/dashboard/organizations/${organizationId}/invitations`;

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const body = invitationListSchema.parse(await requestJson(base, { signal: abort.signal }));
        if (!abort.signal.aborted) { setInvitations(body); setLoadError(undefined); }
      } catch (cause) {
        if (!abort.signal.aborted) setLoadError(errorMessage(cause, "Não foi possível consultar os convites."));
      }
    })();
    return () => abort.abort();
  }, [base, refresh]);

  const run = async (action: () => Promise<string>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage(undefined);
    try {
      setMessage({ kind: "ok", text: await action() });
    } catch (cause) {
      setMessage({ kind: "error", text: errorMessage(cause) });
    } finally {
      lock.current = false; setBusy(false);
      setRefresh((value) => value + 1);
    }
  };

  const send = () => run(async () => {
    const target = email.trim();
    await requestJson(base, { method: "POST", body: { email: target, role: inviteRole } });
    setEmail("");
    return `Convite enviado para ${target.toLowerCase()}.`;
  });

  const confirmRevoke = () => {
    const selected = revoke;
    setRevoke(undefined);
    if (!selected) return;
    void run(async () => {
      await requestJson(`${base}/${selected.id}`, { method: "DELETE" });
      return `Convite de ${selected.email} revogado.`;
    });
  };

  return (
    <section className={sectionClass} aria-labelledby="invitations-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="invitations-title" className="font-heading text-xl font-semibold">Convites</h2>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Atualizar</Button>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-zinc-400">O link vai por e-mail, vale para aquele endereço e só pode ser usado uma vez.</p>
      <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="min-w-0 flex-1 text-sm text-zinc-400">E-mail
          <Input className="mt-2" type="email" value={email} maxLength={320} required autoComplete="off" placeholder="pessoa@empresa.com" disabled={busy} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="text-sm text-zinc-400">Papel
          <select className={`${selectClass} mt-2 block`} value={inviteRole} disabled={busy || role !== "OWNER"} onChange={(event) => setInviteRole(event.target.value as AssignableRole)}>
            <option value="MEMBER">{ROLE_LABELS.MEMBER}</option>
            {role === "OWNER" ? <option value="ADMIN">{ROLE_LABELS.ADMIN}</option> : null}
          </select>
        </label>
        <Button type="submit" disabled={busy || !email.trim()}>{busy ? "Aguarde…" : "Enviar convite"}</Button>
      </form>
      {message ? <p role={message.kind === "error" ? "alert" : "status"} className={`mt-4 text-sm ${message.kind === "error" ? "text-red-300" : "text-emerald-300"}`}>{message.text}</p> : null}
      {loadError ? <p role="alert" className="mt-5 text-sm text-red-300">{loadError}</p> : !invitations ? <LoadingState label="Consultando convites" /> : !invitations.items.length ? (
        <div className="mt-5"><EmptyState title="Nenhum convite enviado" description="Convide quem opera a expedição com você." /></div>
      ) : (
        <ul className="mt-5 divide-y divide-white/10 rounded-xl border border-white/10">
          {invitations.items.map((item) => {
            const revocable = item.status === "PENDING" && (role === "OWNER" || item.role === "MEMBER");
            return (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.email}</p>
                  <p className="mt-1 text-xs text-zinc-500">{ROLE_LABELS[item.role]} · {STATUS_LABELS[item.status]} · Enviado em {formatDate(item.createdAt)}{item.status === "PENDING" ? ` · Expira em ${formatDate(item.expiresAt)}` : ""}</p>
                </div>
                {revocable ? <Button variant="ghost" size="sm" disabled={busy} aria-label={`Revogar convite de ${item.email}`} onClick={() => setRevoke(item)}>Revogar</Button> : null}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={Boolean(revoke)} onClose={() => setRevoke(undefined)} onConfirm={confirmRevoke} title="Revogar este convite?" description={`O link enviado para ${revoke?.email ?? "este endereço"} deixa de funcionar imediatamente.`} confirmLabel="Revogar convite" />
    </section>
  );
}
