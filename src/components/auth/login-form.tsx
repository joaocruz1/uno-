"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import type { PaidPlanId } from "@/lib/billing-model";
import { authQuery, checkoutPath, explicitDestination, loginDestination } from "@/lib/checkout-intent";

import { friendlyAuthError } from "./auth-errors";
import { Field, FormMessage, SubmitButton } from "./form-fields";
import { AuthDivider, GoogleButton } from "./google-button";

export function LoginForm({
  callbackURL,
  plan,
  googleEnabled = false,
  initialError,
}: {
  callbackURL?: string;
  plan?: PaidPlanId;
  googleEnabled?: boolean;
  initialError?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  const destination = loginDestination(callbackURL, plan);
  const explicit = explicitDestination(callbackURL);
  const suffix = authQuery(callbackURL, plan);
  const registerHref = `/register${suffix}`;
  const selfHref = `/login${suffix}`;

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
        callbackURL: destination,
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
            // An account created by this sign-in goes to checkout, unless an
            // explicit destination (an invitation, for example) was requested.
            newUserCallbackURL={explicit || checkoutPath(plan)}
            errorCallbackURL={selfHref}
            disabled={pending}
            onError={setError}
          />
          <AuthDivider />
        </>
      ) : null}
      <form onSubmit={submit} className="space-y-4">
        <Field label="E-mail" name="email" type="email" autoComplete="email" placeholder="voce@empresa.com" />
        <Field label="Senha" name="password" type="password" autoComplete="current-password" />
        <div className="flex items-center justify-between gap-4 text-sm">
          <label className="flex items-center gap-2 text-zinc-400"><input name="rememberMe" type="checkbox" className="accent-uno-red" /> Continuar conectado</label>
          <Link href="/forgot-password" className="text-zinc-300 hover:text-white">Esqueci a senha</Link>
        </div>
        <SubmitButton pending={pending}>Entrar</SubmitButton>
      </form>
      <p className="text-center text-sm text-zinc-500">Ainda não tem conta? <Link href={registerHref} className="font-semibold text-white hover:text-uno-red">Criar conta</Link></p>
    </div>
  );
}
