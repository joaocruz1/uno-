"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, Dialog, LoadingState, Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { memberListSchema, ROLE_LABELS, type AssignableRole, type Member, type MemberList, type MembershipRole } from "@/lib/management-model";

import { errorMessage, formatDate, requestJson } from "./request";

const sectionClass = "rounded-2xl border border-white/10 bg-[#080808] p-6";
const selectClass = "h-9 rounded-lg border border-white/10 bg-[#0d0d0d] px-2 text-sm text-white outline-none focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 disabled:opacity-50";

type Pending =
  | { kind: "remove"; member: Member }
  | { kind: "leave"; member: Member }
  | { kind: "role"; member: Member; role: AssignableRole }
  | { kind: "transfer"; member: Member };

/** Mirrors the server rule for display only; the server decides on every request. */
function manages(viewer: MembershipRole, target: MembershipRole): boolean {
  if (target === "OWNER") return false;
  return viewer === "OWNER" || (viewer === "ADMIN" && target === "MEMBER");
}

export function MembersSection({ organizationId, viewerUserId }: { organizationId: string; viewerUserId: string }) {
  const router = useRouter();
  const [members, setMembers] = useState<MemberList>();
  const [loadError, setLoadError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<Pending>();
  const [transferTarget, setTransferTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const lock = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const body = memberListSchema.parse(await requestJson(`/api/dashboard/organizations/${organizationId}/members`, { signal: abort.signal }));
        if (!abort.signal.aborted) { setMembers(body); setLoadError(undefined); }
      } catch (cause) {
        if (!abort.signal.aborted) setLoadError(errorMessage(cause, "Não foi possível consultar os membros."));
      }
    })();
    return () => abort.abort();
  }, [organizationId, refresh]);

  const confirm = async () => {
    if (!pending || lock.current) return;
    const action = pending;
    lock.current = true; setBusy(true); setMessage(undefined); setPending(undefined);
    const base = `/api/dashboard/organizations/${organizationId}`;
    try {
      if (action.kind === "role") {
        await requestJson(`${base}/members/${action.member.userId}`, { method: "PATCH", body: { role: action.role } });
        setMessage({ kind: "ok", text: `${action.member.name} agora é ${ROLE_LABELS[action.role]}.` });
      } else if (action.kind === "remove") {
        await requestJson(`${base}/members/${action.member.userId}`, { method: "DELETE" });
        setMessage({ kind: "ok", text: `${action.member.name} não participa mais da organização.` });
      } else if (action.kind === "leave") {
        await requestJson(`${base}/members/${action.member.userId}`, { method: "DELETE" });
        router.push("/dashboard");
        router.refresh();
        return;
      } else {
        await requestJson(`${base}/transfer-ownership`, { method: "POST", body: { userId: action.member.userId } });
        setTransferTarget("");
        setMessage({ kind: "ok", text: `${action.member.name} agora é o proprietário. Você passou a administrador.` });
        router.refresh();
      }
      setRefresh((value) => value + 1);
    } catch (cause) {
      setMessage({ kind: "error", text: errorMessage(cause) });
      setRefresh((value) => value + 1);
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  const viewerRole = members?.viewerRole;
  const others = members?.items.filter((member) => member.userId !== viewerUserId) ?? [];
  const dialog = pending ? {
    remove: { title: "Remover este membro?", description: `${pending.member.name} perde o acesso à organização na próxima solicitação. O histórico permanece.`, confirmLabel: "Remover membro" },
    leave: { title: "Sair desta organização?", description: "Você perde o acesso ao histórico, às chaves e à assinatura desta organização. Para voltar, será preciso um novo convite.", confirmLabel: "Sair da organização" },
    role: { title: "Alterar o papel?", description: `${pending.member.name} passará a ser ${pending.kind === "role" ? ROLE_LABELS[pending.role] : ""}. ${pending.kind === "role" && pending.role === "ADMIN" ? "Administradores gerenciam membros, convites, chaves e assinatura." : "A mudança vale na próxima solicitação."}`, confirmLabel: "Alterar papel" },
    transfer: { title: "Transferir a propriedade?", description: `${pending.member.name} passará a ser o único proprietário e você se tornará administrador. Só o novo proprietário poderá desfazer esta mudança.`, confirmLabel: "Transferir propriedade" },
  }[pending.kind] : undefined;

  return (
    <>
      <section className={sectionClass} aria-labelledby="members-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="members-title" className="font-heading text-xl font-semibold">Membros</h2>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Atualizar</Button>
        </div>
        <p className="mt-2 text-sm text-zinc-400">Há sempre um único proprietário. Administradores gerenciam membros; só o proprietário gerencia administradores.</p>
        {message ? <p role={message.kind === "error" ? "alert" : "status"} className={`mt-4 text-sm ${message.kind === "error" ? "text-red-300" : "text-emerald-300"}`}>{message.text}</p> : null}
        {loadError ? <p role="alert" className="mt-5 text-sm text-red-300">{loadError}</p> : !members || !viewerRole ? <LoadingState label="Consultando membros" /> : (
          <div className="mt-5 rounded-xl border border-white/10">
            <Table>
              <TableHeader><tr><TableHead>Pessoa</TableHead><TableHead>Papel</TableHead><TableHead>Desde</TableHead><TableHead className="text-right">Ações</TableHead></tr></TableHeader>
              <tbody>
                {members.items.map((member) => {
                  const self = member.userId === viewerUserId;
                  const manageable = !self && manages(viewerRole, member.role);
                  const canChangeRole = manageable && viewerRole === "OWNER";
                  return (
                    <TableRow key={member.userId}>
                      <TableCell><p className="font-medium text-white">{member.name}{self ? " (você)" : ""}</p><p className="mt-1 text-xs text-zinc-500">{member.email}</p></TableCell>
                      <TableCell>
                        {canChangeRole ? (
                          <select className={selectClass} aria-label={`Papel de ${member.name}`} value={member.role} disabled={busy} onChange={(event) => setPending({ kind: "role", member, role: event.target.value as AssignableRole })}>
                            <option value="ADMIN">{ROLE_LABELS.ADMIN}</option>
                            <option value="MEMBER">{ROLE_LABELS.MEMBER}</option>
                          </select>
                        ) : ROLE_LABELS[member.role]}
                      </TableCell>
                      <TableCell>{formatDate(member.joinedAt)}</TableCell>
                      <TableCell className="text-right">
                        {self && member.role !== "OWNER" ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPending({ kind: "leave", member })}>Sair</Button> : null}
                        {manageable ? <Button variant="ghost" size="sm" disabled={busy} aria-label={`Remover ${member.name}`} onClick={() => setPending({ kind: "remove", member })}>Remover</Button> : null}
                        {!manageable && !(self && member.role !== "OWNER") ? <span className="text-xs text-zinc-600">—</span> : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </section>

      {viewerRole === "OWNER" ? (
        <section className={sectionClass} aria-labelledby="transfer-title">
          <h2 id="transfer-title" className="font-heading text-xl font-semibold">Transferir propriedade</h2>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">O novo proprietário precisa já ser membro. Você continua na organização como administrador.</p>
          {others.length ? (
            <div className="mt-5 flex flex-wrap items-end gap-3">
              <label className="min-w-0 flex-1 text-sm text-zinc-400">Novo proprietário
                <select className={`${selectClass} mt-2 h-11 w-full`} value={transferTarget} disabled={busy} onChange={(event) => setTransferTarget(event.target.value)}>
                  <option value="">Selecione um membro</option>
                  {others.map((member) => <option key={member.userId} value={member.userId}>{member.name} — {member.email}</option>)}
                </select>
              </label>
              <Button variant="secondary" disabled={busy || !transferTarget} onClick={() => { const member = others.find((item) => item.userId === transferTarget); if (member) setPending({ kind: "transfer", member }); }}>Transferir…</Button>
            </div>
          ) : <p className="mt-5 text-sm text-zinc-500">Convide alguém antes de transferir a propriedade.</p>}
        </section>
      ) : null}

      <Dialog open={Boolean(pending)} onClose={() => setPending(undefined)} onConfirm={() => void confirm()} title={dialog?.title ?? ""} description={dialog?.description ?? ""} confirmLabel={dialog?.confirmLabel} />
    </>
  );
}
