"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

import { Field, FormMessage, friendlyAuthError, SubmitButton } from "./form-fields";

export function RegisterForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const confirmation = String(data.get("confirmation") ?? "");
    if (password !== confirmation) {
      setPending(false);
      setError("As senhas não coincidem.");
      return;
    }
    try {
      const result = await authClient.signUp.email({
        name: String(data.get("name") ?? ""),
        email,
        password,
        callbackURL: "/verify-email?verified=1",
      });
      if (result.error) {
        setError(friendlyAuthError(result.error.code));
        return;
      }
      router.push(`/verify-email?email=${encodeURIComponent(email)}`);
    } catch {
      setError(friendlyAuthError());
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <FormMessage error={error} />
      <Field label="Nome" name="name" autoComplete="name" placeholder="Seu nome" />
      <Field label="E-mail" name="email" type="email" autoComplete="email" placeholder="voce@empresa.com" />
      <Field label="Senha" name="password" type="password" autoComplete="new-password" minLength={8} />
      <Field label="Confirmar senha" name="confirmation" type="password" autoComplete="new-password" minLength={8} />
      <SubmitButton pending={pending}>Criar conta</SubmitButton>
      <p className="text-center text-sm text-zinc-500">Já tem uma conta? <Link href="/login" className="font-semibold text-white hover:text-uno-red">Entrar</Link></p>
    </form>
  );
}
