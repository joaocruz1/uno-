"use client";

import Link from "next/link";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

import { Field, FormMessage, SubmitButton } from "./form-fields";

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setSuccess(undefined);
    const data = new FormData(event.currentTarget);
    try {
      const result = await authClient.requestPasswordReset({
        email: String(data.get("email") ?? ""),
        redirectTo: "/reset-password",
      });
      if (result.error) {
        setError("Não foi possível enviar o e-mail. Tente novamente.");
        return;
      }
      setSuccess("Se este e-mail estiver cadastrado, você receberá as instruções em instantes.");
    } catch {
      setError("Não foi possível enviar o e-mail. Tente novamente.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <FormMessage error={error} success={success} />
      <Field label="E-mail" name="email" type="email" autoComplete="email" placeholder="voce@empresa.com" />
      <SubmitButton pending={pending}>Enviar instruções</SubmitButton>
      <p className="text-center text-sm"><Link href="/login" className="text-zinc-300 hover:text-white">Voltar para entrar</Link></p>
    </form>
  );
}
