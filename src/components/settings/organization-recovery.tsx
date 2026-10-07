"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Input } from "@/components/ui";

import { errorMessage, requestJson } from "./request";

/** Shown when the signed-in user no longer belongs to any organization. */
export function OrganizationRecovery() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await requestJson("/api/dashboard/organizations", { method: "POST", body: { name: name.trim() } });
      router.push("/dashboard");
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label htmlFor="organization-name" className="block text-sm font-medium text-zinc-200">Nome da organização</label>
      <Input id="organization-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoFocus />
      {error ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
      <Button type="submit" disabled={busy || name.trim().length === 0} className="w-full">{busy ? "Criando…" : "Criar organização"}</Button>
      <p className="text-center text-xs text-zinc-500">Recebeu um convite? Abra o link enviado por e-mail para entrar na organização da sua equipe.</p>
    </form>
  );
}
