"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import type { PaidPlanId } from "@/lib/billing-model";
import { authQuery, registerDestination } from "@/lib/checkout-intent";

import { friendlyAuthError } from "./auth-errors";
import { Field, FormMessage, SubmitButton } from "./form-fields";
import { AuthDivider, GoogleButton } from "./google-button";

export function RegisterForm({
  callbackURL,
  plan,
  freePlan = false,
  googleEnabled = false,
  initialError,
}: {
  callbackURL?: string;
  plan?: PaidPlanId;
  freePlan?: boolean;
  googleEnabled?: boolean;
  initialError?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  const destination = registerDestination(callbackURL, plan, freePlan);
  const suffix = authQuery(callbackURL, plan ?? (freePlan ? "free" : undefined));
  const loginHref = `/login${suffix}`;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");
    const confirmation = String(data.get("confirmation") ?? "");
    if (password !== confirmation) {
      setPending(false);
      setError("As senhas não coincidem.");
      return;
    }
    try {
      // E-mail confirmation no longer blocks access: sign-up signs in at once.
      const result = await authClient.signUp.email({
        name: String(data.get("name") ?? ""),
        email: String(data.get("email") ?? ""),
        password,
      });
      if (result.error) {
        setError(friendlyAuthError(result.error.code));
        return;
      }
      router.push(destination);
      router.refresh();
    } catch {
      setError(friendlyAuthError());
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5">
      <FormMessage error={error} />
      {googleEnabled ? (
        <>
          <GoogleButton
            callbackURL={destination}
            newUserCallbackURL={destination}
            errorCallbackURL={`/register${suffix}`}
            disabled={pending}
            onError={setError}
          />
          <AuthDivider />
        </>
      ) : null}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome" name="name" autoComplete="name" placeholder="Seu nome" />
        <Field label="E-mail" name="email" type="email" autoComplete="email" placeholder="voce@empresa.com" />
        <Field label="Senha" name="password" type="password" autoComplete="new-password" minLength={8} />
        <Field label="Confirmar senha" name="confirmation" type="password" autoComplete="new-password" minLength={8} />
        <SubmitButton pending={pending}>Criar conta</SubmitButton>
      </form>
      <p className="text-center text-sm text-zinc-500">Já tem uma conta? <Link href={loginHref} className="font-semibold text-white hover:text-uno-red">Entrar</Link></p>
    </div>
  );
}
