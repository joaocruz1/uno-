import type { Metadata } from "next";

import { AuthShell, VerificationForm } from "@/components/auth";

export const metadata: Metadata = { title: "Confirmar e-mail" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string | string[]; verified?: string | string[] }>;
}) {
  const query = await searchParams;
  const email = typeof query.email === "string" ? query.email : undefined;
  const verified = query.verified === "1";
  return (
    <AuthShell
      title={verified ? "E-mail confirmado" : "Confirme seu e-mail"}
      description={verified ? "Seu endereço está confirmado. Por segurança, entre novamente." : "Confirmar o e-mail é opcional para usar o painel e necessário para aceitar convites. O link expira em uma hora."}
    >
      <VerificationForm initialEmail={email} verified={verified} />
    </AuthShell>
  );
}
