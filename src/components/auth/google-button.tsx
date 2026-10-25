"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth-client";

import { friendlyAuthError } from "./auth-errors";

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="size-[18px] shrink-0">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/**
 * Starts Google sign-in. Better Auth sends existing accounts to `callbackURL`,
 * accounts created by this sign-in to `newUserCallbackURL`, and failures to
 * `errorCallbackURL` with an `?error=` code the page translates.
 */
export function GoogleButton({
  callbackURL,
  newUserCallbackURL,
  errorCallbackURL,
  disabled,
  onError,
}: {
  callbackURL: string;
  newUserCallbackURL: string;
  errorCallbackURL: string;
  disabled?: boolean;
  onError(message: string): void;
}) {
  const [pending, setPending] = useState(false);

  async function start() {
    if (pending) return;
    setPending(true);
    try {
      const result = await authClient.signIn.social({ provider: "google", callbackURL, newUserCallbackURL, errorCallbackURL });
      if (result.error) {
        onError(friendlyAuthError(result.error.code));
        setPending(false);
      }
      // On success the browser is already navigating to Google.
    } catch {
      onError(friendlyAuthError());
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={pending || disabled}
      aria-busy={pending}
      className="group flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-white/15 bg-white px-4 text-sm font-semibold text-[#1f1f1f] shadow-[0_1px_0_rgba(255,255,255,.08)_inset] transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red focus-visible:ring-offset-2 focus-visible:ring-offset-[#080808] disabled:cursor-wait disabled:opacity-70"
    >
      <GoogleMark />
      <span>{pending ? "Abrindo o Google…" : "Continuar com Google"}</span>
    </button>
  );
}

export function AuthDivider() {
  return (
    <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-[.14em] text-zinc-500" role="separator" aria-label="ou">
      <span className="h-px flex-1 bg-white/10" />
      <span aria-hidden="true">ou</span>
      <span className="h-px flex-1 bg-white/10" />
    </div>
  );
}
