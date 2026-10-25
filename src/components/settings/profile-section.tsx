"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { PhoneInput } from "@/components/auth/phone-input";
import { Button, Input, LoadingState } from "@/components/ui";
import { authClient } from "@/lib/auth-client";
import { formatBrPhone, normalizeBrPhone, PHONE_INVALID_MESSAGE } from "@/lib/phone";

const sectionClass = "rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6";
const FALLBACK = "Não foi possível concluir a solicitação. Tente novamente.";

type Message = { kind: "ok" | "error"; text: string };

function authMessage(error: { message?: string; code?: string } | null | undefined, fallback = FALLBACK): string {
  switch (error?.code) {
    case "INVALID_PASSWORD": return "A senha atual está incorreta.";
    case "PASSWORD_TOO_SHORT": return "A nova senha precisa ter pelo menos 8 caracteres.";
    case "PASSWORD_TOO_LONG": return "A nova senha pode ter no máximo 128 caracteres.";
    case "EMAIL_ALREADY_VERIFIED": return "Este e-mail já está confirmado.";
    default: return fallback;
  }
}

function Feedback({ message }: { message: Message | undefined }) {
  if (!message) return null;
  return <p role={message.kind === "error" ? "alert" : "status"} className={`mt-4 text-sm ${message.kind === "error" ? "text-uno-red" : "text-[var(--color-ink)]"}`}>{message.text}</p>;
}

/** Name, e-mail confirmation and password of the signed-in user (not of the organization). */
export function ProfileSection({ initialName, email }: { initialName: string; email: string }) {
  const router = useRouter();
  const session = authClient.useSession();
  const verified = session.data?.user.emailVerified;
  const savedName = session.data?.user.name ?? initialName;
  const [name, setName] = useState(initialName);
  const [hasPassword, setHasPassword] = useState<boolean>();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const savedPhone = session.data?.user.phone ?? null;
  // null until the person edits the field: shows the stored phone once the session loads.
  const [phoneDraft, setPhoneDraft] = useState<string | null>(null);
  const phone = phoneDraft ?? formatBrPhone(savedPhone);
  const [busy, setBusy] = useState<"name" | "phone" | "verify" | "password">();
  const [profileMessage, setProfileMessage] = useState<Message>();
  const [passwordMessage, setPasswordMessage] = useState<Message>();
  const lock = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data } = await authClient.listAccounts();
        // Only an e-mail/password ("credential") account has a password to change; Google-only users do not.
        if (active) setHasPassword(Array.isArray(data) ? data.some((account) => account.providerId === "credential") : false);
      } catch {
        if (active) setHasPassword(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const run = async (operation: "name" | "phone" | "verify" | "password", action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(operation);
    try { await action(); } finally { lock.current = false; setBusy(undefined); }
  };

  const saveName = () => run("name", async () => {
    setProfileMessage(undefined);
    const { error } = await authClient.updateUser({ name: name.trim() }).catch(() => ({ error: { message: FALLBACK } }));
    if (error) { setProfileMessage({ kind: "error", text: authMessage(error, "Não foi possível salvar o nome.") }); return; }
    setProfileMessage({ kind: "ok", text: "Nome atualizado." });
    router.refresh();
  });

  const savePhone = () => run("phone", async () => {
    setProfileMessage(undefined);
    const normalized = normalizeBrPhone(phone);
    if (!normalized) { setProfileMessage({ kind: "error", text: PHONE_INVALID_MESSAGE }); return; }
    const { error } = await authClient.updateUser({ phone: normalized }).catch(() => ({ error: { message: FALLBACK } }));
    if (error) { setProfileMessage({ kind: "error", text: authMessage(error, "Não foi possível salvar o telefone.") }); return; }
    setPhoneDraft(null);
    setProfileMessage({ kind: "ok", text: "Telefone atualizado." });
    router.refresh();
  });

  const sendVerification = () => run("verify", async () => {
    setProfileMessage(undefined);
    const { error } = await authClient.sendVerificationEmail({ email, callbackURL: "/dashboard/settings" }).catch(() => ({ error: { message: FALLBACK } }));
    setProfileMessage(error
      ? { kind: "error", text: authMessage(error, "Não foi possível enviar o e-mail. Aguarde um pouco e tente de novo.") }
      : { kind: "ok", text: `Enviamos um link de confirmação para ${email}. Ele vale por 1 hora.` });
  });

  const changePassword = () => run("password", async () => {
    setPasswordMessage(undefined);
    if (next !== confirm) { setPasswordMessage({ kind: "error", text: "A confirmação não confere com a nova senha." }); return; }
    const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true })
      .catch(() => ({ error: { message: FALLBACK } }));
    if (error) { setPasswordMessage({ kind: "error", text: authMessage(error, "Não foi possível alterar a senha.") }); return; }
    setCurrent(""); setNext(""); setConfirm("");
    setPasswordMessage({ kind: "ok", text: "Senha alterada. As outras sessões abertas foram encerradas." });
  });

  const trimmed = name.trim();

  return (
    <>
      <section className={sectionClass} aria-labelledby="profile-title">
        <h2 id="profile-title" className="font-heading text-xl font-semibold">Perfil</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">Seus dados de acesso. Valem para todas as organizações das quais você participa.</p>
        <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
          <label className="min-w-0 flex-1 text-sm text-[var(--color-muted)]">Nome
            <Input className="mt-2" value={name} minLength={2} maxLength={80} required autoComplete="name" disabled={Boolean(busy)} onChange={(event) => setName(event.target.value)} />
          </label>
          <Button type="submit" disabled={Boolean(busy) || trimmed.length < 2 || trimmed === savedName}>{busy === "name" ? "Salvando…" : "Salvar nome"}</Button>
        </form>
        <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void savePhone(); }}>
          <label className="min-w-0 flex-1 text-sm text-[var(--color-muted)]">Telefone (com DDD)
            <PhoneInput
              value={phone}
              onValueChange={setPhoneDraft}
              required
              disabled={Boolean(busy)}
              className="mt-2 h-11 w-full rounded-lg border border-[var(--c-line)] bg-[var(--c-surface-2)] px-3 text-sm text-[var(--c-ink)] outline-none placeholder:text-[var(--c-faint)] focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 disabled:opacity-50"
            />
          </label>
          <Button type="submit" disabled={Boolean(busy) || !normalizeBrPhone(phone) || normalizeBrPhone(phone) === savedPhone}>{busy === "phone" ? "Salvando…" : "Salvar telefone"}</Button>
        </form>
        <div className="mt-6">
          <p className="text-sm text-[var(--color-muted)]">E-mail</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-[var(--color-ink)]">{email}</span>
            {verified === undefined ? null : verified
              ? <span className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs font-semibold text-[var(--color-ink)]">Confirmado</span>
              : <span className="rounded-full border border-uno-red/30 bg-uno-red/10 px-3 py-1 text-xs font-semibold text-uno-red">Não confirmado</span>}
            {verified === false ? <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void sendVerification()}>{busy === "verify" ? "Enviando…" : "Confirmar e-mail"}</Button> : null}
          </div>
          <p className="mt-2 text-xs text-[var(--color-muted)]">Para trocar o e-mail de acesso, fale com o suporte.</p>
        </div>
        <Feedback message={profileMessage} />
      </section>

      <section className={sectionClass} aria-labelledby="password-title">
        <h2 id="password-title" className="font-heading text-xl font-semibold">Senha</h2>
        {hasPassword === undefined ? <LoadingState label="Consultando formas de acesso" /> : hasPassword ? (
          <form className="mt-6 grid gap-4 md:grid-cols-3" onSubmit={(event) => { event.preventDefault(); void changePassword(); }}>
            <label className="text-sm text-[var(--color-muted)]">Senha atual
              <Input className="mt-2" type="password" value={current} required autoComplete="current-password" disabled={Boolean(busy)} onChange={(event) => setCurrent(event.target.value)} />
            </label>
            <label className="text-sm text-[var(--color-muted)]">Nova senha
              <Input className="mt-2" type="password" value={next} required minLength={8} maxLength={128} autoComplete="new-password" disabled={Boolean(busy)} onChange={(event) => setNext(event.target.value)} />
            </label>
            <label className="text-sm text-[var(--color-muted)]">Confirmar nova senha
              <Input className="mt-2" type="password" value={confirm} required minLength={8} maxLength={128} autoComplete="new-password" disabled={Boolean(busy)} onChange={(event) => setConfirm(event.target.value)} />
            </label>
            <div className="md:col-span-3 flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={Boolean(busy) || !current || next.length < 8 || !confirm}>{busy === "password" ? "Alterando…" : "Alterar senha"}</Button>
              <p className="text-xs text-[var(--color-muted)]">Ao alterar, as outras sessões abertas são encerradas.</p>
            </div>
          </form>
        ) : (
          <p className="mt-2 text-sm text-[var(--color-muted)]">Você entra com uma conta externa (como o Google), sem senha na UNO. Para criar uma, peça um link em <Link href="/forgot-password" className="font-semibold text-uno-red underline-offset-4 hover:underline">Esqueci minha senha</Link>.</p>
        )}
        <Feedback message={passwordMessage} />
      </section>
    </>
  );
}
