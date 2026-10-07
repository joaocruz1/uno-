"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

import { Field, FormMessage, friendlyAuthError, SubmitButton } from "./form-fields";

export function ResetPasswordForm({ token }: { token?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(token ? undefined : "Este link é inválido ou expirou.");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");
    if (password !== String(data.get("confirmation") ?? "")) {
      setPending(false);
      setError("As senhas não coincidem.");
      return;
    }
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(friendlyAuthError(result.error.code));
        return;
      }
      router.push("/login?reset=1");
    } catch {
      setError(friendlyAuthError());
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <FormMessage error={error} />
      <Field label="Nova senha" name="password" type="password" autoComplete="new-password" minLength={8} />
      <Field label="Confirmar nova senha" name="confirmation" type="password" autoComplete="new-password" minLength={8} />
      <SubmitButton pending={pending || !token}>Salvar nova senha</SubmitButton>
    </form>
  );
}
