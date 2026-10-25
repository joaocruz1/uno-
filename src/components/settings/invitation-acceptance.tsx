"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, ButtonLink, LoadingState } from "@/components/ui";
import { authClient } from "@/lib/auth-client";
import { acceptedInvitationSchema, ROLE_LABELS, type AcceptedInvitation } from "@/lib/management-model";

import { RequestError, requestJson } from "./request";

const STORAGE_KEY = "uno_pending_invitation";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN_URL = "/login?callbackURL=/invite";
const REGISTER_URL = "/register?callbackURL=/invite";
const VERIFY_CALLBACK_URL = "/invite";

type State =
  | { step: "reading" }
  | { step: "missing" }
  | { step: "ready" }
  | { step: "sending" }
  | { step: "login" }
  | { step: "verify"; sending?: boolean; sent?: boolean; error?: string }
  | { step: "done"; accepted: AcceptedInvitation }
  | { step: "failed"; text: string; retry: boolean };

function readToken(): string | undefined {
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
  const fromQuery = new URLSearchParams(window.location.search).get("token");
  let stored: string | null = null;
  try { stored = sessionStorage.getItem(STORAGE_KEY); } catch { stored = null; }
  const token = [fromHash, fromQuery, stored].find((candidate) => candidate && TOKEN_PATTERN.test(candidate));
  if (fromHash || fromQuery) {
    // Keep the single-use token out of the address bar, history and referrers.
    window.history.replaceState(null, "", window.location.pathname);
  }
  return token ?? undefined;
}

function remember(token: string | undefined) {
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Without storage the person can open the e-mail link again after signing in.
  }
}

export function InvitationAcceptance() {
  const router = useRouter();
  const token = useRef<string | undefined>(undefined);
  const [state, setState] = useState<State>({ step: "reading" });

  useEffect(() => {
    // The token only exists in the browser, so it is read after hydration.
    const found = readToken() ?? token.current;
    token.current = found;
    remember(found);
    let active = true;
    queueMicrotask(() => { if (active) setState(found ? { step: "ready" } : { step: "missing" }); });
    return () => { active = false; };
  }, []);

  const accept = async () => {
    if (!token.current || state.step === "sending") return;
    setState({ step: "sending" });
    try {
      const accepted = acceptedInvitationSchema.parse(await requestJson("/api/dashboard/invitations/accept", { method: "POST", body: { token: token.current } }));
      remember(undefined);
      setState({ step: "done", accepted });
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 401) { setState({ step: "login" }); return; }
      if (cause instanceof RequestError && cause.code === "email_not_verified") { setState({ step: "verify" }); return; }
      const transient = !(cause instanceof RequestError) || !cause.status || cause.status === 429 || cause.status >= 500;
      if (!transient && cause instanceof RequestError && cause.code !== "invitation_email_mismatch") remember(undefined);
      setState({ step: "failed", text: cause instanceof RequestError ? cause.message : "Não foi possível aceitar o convite. Tente novamente.", retry: transient });
    }
  };

  if (state.step === "reading") return <LoadingState label="Lendo o convite" />;
  if (state.step === "missing") {
    return <div><p role="alert" className="text-sm text-red-300">Este link de convite está incompleto.</p><p className="mt-3 text-sm text-[var(--color-muted)]">Abra novamente o link recebido por e-mail ou peça um novo convite a quem administra a organização.</p><Link href="/dashboard" className="mt-5 inline-block text-sm font-semibold text-[var(--color-ink)] hover:text-uno-red">Ir para o painel</Link></div>;
  }
  if (state.step === "done") {
    return <div><p role="status" className="text-sm text-emerald-300">Convite aceito.</p><p className="mt-3 text-sm text-[var(--color-ink)]">Você agora participa de <strong className="text-[var(--color-ink)]">{state.accepted.organizationName}</strong> como {ROLE_LABELS[state.accepted.role]}.</p><Button className="mt-6 w-full" onClick={() => { router.push("/dashboard"); router.refresh(); }}>Abrir a organização</Button></div>;
  }
  if (state.step === "login") {
    return <div><p role="status" className="text-sm text-[var(--color-ink)]">Entre com a conta do e-mail que recebeu o convite. Ele continua guardado nesta aba.</p><div className="mt-6 grid gap-3"><ButtonLink href={LOGIN_URL}>Entrar para aceitar</ButtonLink><Link href={REGISTER_URL} className="text-center text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]">Ainda não tenho conta</Link></div><p className="mt-4 text-xs text-[var(--color-muted)]">Para aceitar, o e-mail da conta precisa estar confirmado; enviaremos o link quando for preciso.</p></div>;
  }
  if (state.step === "verify") {
    // Invitations match by e-mail, so accepting one requires a confirmed address.
    const sendLink = async () => {
      if (state.sending) return;
      setState({ step: "verify", sending: true });
      try {
        const session = await authClient.getSession();
        const email = session.data?.user.email;
        if (!email) { setState({ step: "login" }); return; }
        const result = await authClient.sendVerificationEmail({ email, callbackURL: VERIFY_CALLBACK_URL });
        if (result.error) {
          setState({ step: "verify", error: result.error.code?.toUpperCase() === "EMAIL_ALREADY_VERIFIED" ? "Seu e-mail já está confirmado. Tente aceitar o convite outra vez." : "Não foi possível enviar agora. Aguarde um pouco e tente novamente." });
          return;
        }
        setState({ step: "verify", sent: true });
      } catch {
        setState({ step: "verify", error: "Não foi possível enviar agora. Aguarde um pouco e tente novamente." });
      }
    };
    return (
      <div>
        <p role="alert" className="text-sm text-[var(--color-ink)]">Para aceitar o convite, confirme primeiro o e-mail da sua conta.</p>
        <p className="mt-3 text-sm text-[var(--color-muted)]">Enviaremos um link de confirmação para o seu e-mail. Depois de confirmar, volte a esta aba e toque em “Já confirmei, aceitar convite”.</p>
        {state.sent ? <p role="status" className="mt-4 text-sm text-emerald-300">Link enviado. Confira sua caixa de entrada (e o spam); ele expira em uma hora.</p> : null}
        {state.error ? <p role="alert" className="mt-4 text-sm text-red-300">{state.error}</p> : null}
        <div className="mt-6 grid gap-3">
          <Button disabled={state.sending} onClick={() => void sendLink()}>{state.sending ? "Enviando…" : state.sent ? "Reenviar link de confirmação" : "Enviar link de confirmação"}</Button>
          <Button variant="secondary" onClick={() => void accept()}>Já confirmei, aceitar convite</Button>
        </div>
      </div>
    );
  }
  if (state.step === "failed") {
    return <div><p role="alert" className="text-sm text-red-300">{state.text}</p>{state.retry ? <Button className="mt-6 w-full" onClick={() => void accept()}>Tentar novamente</Button> : <Link href="/dashboard" className="mt-5 inline-block text-sm font-semibold text-[var(--color-ink)] hover:text-uno-red">Ir para o painel</Link>}</div>;
  }
  return (
    <div>
      <p className="text-sm text-[var(--color-ink)]">Ao aceitar, sua conta passa a participar da organização que enviou o convite.</p>
      <Button className="mt-6 w-full" disabled={state.step === "sending"} onClick={() => void accept()}>{state.step === "sending" ? "Aceitando…" : "Aceitar convite"}</Button>
      <p className="mt-4 text-xs text-[var(--color-muted)]">O convite vale para o e-mail que o recebeu e só pode ser usado uma vez.</p>
    </div>
  );
}
