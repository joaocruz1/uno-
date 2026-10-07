import type { Metadata } from "next";

import { AuthShell, LoginForm } from "@/components/auth";

export const metadata: Metadata = { title: "Entrar" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackURL?: string | string[]; reset?: string | string[] }>;
}) {
  const query = await searchParams;
  const callbackURL = typeof query.callbackURL === "string" ? query.callbackURL : undefined;
  return (
    <AuthShell title="Acesse sua conta" description={query.reset === "1" ? "Senha atualizada. Entre com sua nova senha." : "Converta, organize e acompanhe suas etiquetas em um só lugar."}>
      <LoginForm callbackURL={callbackURL} />
    </AuthShell>
  );
}
