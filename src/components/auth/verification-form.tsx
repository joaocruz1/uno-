"use client";

import Link from "next/link";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

import { Field, FormMessage, SubmitButton } from "./form-fields";

export function VerificationForm({ initialEmail, verified }: { initialEmail?: string; verified?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string | undefined>(verified ? "E-mail confirmado. Sua conta está pronta." : undefined);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setSuccess(undefined);
    const data = new FormData(event.currentTarget);
    try {
      const result = await authClient.sendVerificationEmail({
        email: String(data.get("email") ?? ""),
        callbackURL: "/verify-email?verified=1",
      });
      if (result.error) {
        setError("Não foi possível reenviar agora. Aguarde e tente novamente.");
        return;
      }
      setSuccess("Se a conta estiver aguardando confirmação, um novo link foi enviado.");
    } catch {
      setError("Não foi possível reenviar agora. Aguarde e tente novamente.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5">
      <FormMessage error={error} success={success} />
      {!verified && (
        <form onSubmit={submit} className="space-y-4">
          <Field label="E-mail" name="email" type="email" autoComplete="email" placeholder="voce@empresa.com" defaultValue={initialEmail} readOnly={Boolean(initialEmail)} />
          <SubmitButton pending={pending}>Reenviar confirmação</SubmitButton>
        </form>
      )}
      <p className="text-center text-sm"><Link href="/login" className="font-semibold text-white hover:text-uno-red">Ir para o login</Link></p>
    </div>
  );
}
