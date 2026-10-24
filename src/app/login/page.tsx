import type { Metadata } from "next";

import { AuthShell, LoginForm } from "@/components/auth";
import { oauthCallbackError } from "@/components/auth/auth-errors";
import { parsePlanParam } from "@/lib/checkout-intent";
import { googleSignInEnabled } from "@/lib/env";

export const metadata: Metadata = { title: "Entrar" };

type Query = { callbackURL?: string | string[]; reset?: string | string[]; plan?: string | string[]; error?: string | string[] };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const callbackURL = typeof query.callbackURL === "string" ? query.callbackURL : undefined;
  const plan = parsePlanParam(query.plan);
  return (
    <AuthShell title="Acesse sua conta" description={query.reset === "1" ? "Senha atualizada. Entre com sua nova senha." : "Converta, organize e acompanhe suas etiquetas em um só lugar."}>
      <LoginForm callbackURL={callbackURL} plan={plan} googleEnabled={googleSignInEnabled()} initialError={oauthCallbackError(query.error)} />
    </AuthShell>
  );
}
