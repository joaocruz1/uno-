"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient, safeInternalPath } from "@/lib/auth-client";

import { Field, FormMessage, friendlyAuthError, SubmitButton } from "./form-fields";

export function LoginForm({ callbackURL }: { callbackURL?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      const result = await authClient.signIn.email({
        email: String(data.get("email") ?? ""),
        password: String(data.get("password") ?? ""),
        rememberMe: data.get("rememberMe") === "on",
        callbackURL: safeInternalPath(callbackURL),
      });
      if (result.error) {
        setError(friendlyAuthError(result.error.code));
        return;
      }
      router.push(safeInternalPath(callbackURL));
      router.refresh();
    } catch {
      setError(friendlyAuthError());
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <FormMessage error={error} />
      <Field label="E-mail" name="email" type="email" autoComplete="email" placeholder="voce@empresa.com" />
      <Field label="Senha" name="password" type="password" autoComplete="current-password" />
      <div className="flex items-center justify-between gap-4 text-sm">
        <label className="flex items-center gap-2 text-zinc-400"><input name="rememberMe" type="checkbox" className="accent-uno-red" /> Continuar conectado</label>
        <Link href="/forgot-password" className="text-zinc-300 hover:text-white">Esqueci a senha</Link>
      </div>
      <SubmitButton pending={pending}>Entrar</SubmitButton>
      <p className="text-center text-sm text-zinc-500">Ainda não tem conta? <Link href="/register" className="font-semibold text-white hover:text-uno-red">Criar conta</Link></p>
    </form>
  );
}
