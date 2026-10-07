"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button, ButtonLink, LoadingState } from "@/components/ui";
import { acceptedInvitationSchema, ROLE_LABELS, type AcceptedInvitation } from "@/lib/management-model";

import { RequestError, requestJson } from "./request";

const STORAGE_KEY = "uno_pending_invitation";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN_URL = "/login?callbackURL=/invite";
const REGISTER_URL = "/register";

type State =
  | { step: "reading" }
  | { step: "missing" }
  | { step: "ready" }
  | { step: "sending" }
  | { step: "login" }
  | { step: "verify" }
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
    return <div><p role="alert" className="text-sm text-red-300">Este link de convite está incompleto.</p><p className="mt-3 text-sm text-zinc-400">Abra novamente o link recebido por e-mail ou peça um novo convite a quem administra a organização.</p><Link href="/dashboard" className="mt-5 inline-block text-sm font-semibold text-white hover:text-uno-red">Ir para o painel</Link></div>;
  }
  if (state.step === "done") {
    return <div><p role="status" className="text-sm text-emerald-300">Convite aceito.</p><p className="mt-3 text-sm text-zinc-300">Você agora participa de <strong className="text-white">{state.accepted.organizationName}</strong> como {ROLE_LABELS[state.accepted.role]}.</p><Button className="mt-6 w-full" onClick={() => { router.push("/dashboard"); router.refresh(); }}>Abrir a organização</Button></div>;
  }
  if (state.step === "login") {
    return <div><p role="status" className="text-sm text-zinc-300">Entre com a conta do e-mail que recebeu o convite. Ele continua guardado nesta aba.</p><div className="mt-6 grid gap-3"><ButtonLink href={LOGIN_URL}>Entrar para aceitar</ButtonLink><Link href={REGISTER_URL} className="text-center text-sm text-zinc-400 hover:text-white">Ainda não tenho conta</Link></div><p className="mt-4 text-xs text-zinc-500">Ao criar uma conta, confirme seu e-mail e abra o link do convite outra vez.</p></div>;
  }
  if (state.step === "verify") {
    return <div><p role="alert" className="text-sm text-red-300">Confirme seu e-mail antes de aceitar o convite.</p><Link href="/verify-email" className="mt-5 inline-block text-sm font-semibold text-white hover:text-uno-red">Confirmar e-mail</Link></div>;
  }
  if (state.step === "failed") {
    return <div><p role="alert" className="text-sm text-red-300">{state.text}</p>{state.retry ? <Button className="mt-6 w-full" onClick={() => void accept()}>Tentar novamente</Button> : <Link href="/dashboard" className="mt-5 inline-block text-sm font-semibold text-white hover:text-uno-red">Ir para o painel</Link>}</div>;
  }
  return (
    <div>
      <p className="text-sm text-zinc-300">Ao aceitar, sua conta passa a participar da organização que enviou o convite.</p>
      <Button className="mt-6 w-full" disabled={state.step === "sending"} onClick={() => void accept()}>{state.step === "sending" ? "Aceitando…" : "Aceitar convite"}</Button>
      <p className="mt-4 text-xs text-zinc-500">O convite vale para o e-mail que o recebeu e só pode ser usado uma vez.</p>
    </div>
  );
}
