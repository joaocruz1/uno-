import type { Metadata } from "next";

import { AuthShell, RegisterForm } from "@/components/auth";
import { oauthCallbackError } from "@/components/auth/auth-errors";
import { choseFreePlan, parsePlanParam } from "@/lib/checkout-intent";
import { googleSignInEnabled } from "@/lib/env";
import { getPlanCatalog } from "@/lib/plans";

export const metadata: Metadata = { title: "Criar conta" };

type Query = { callbackURL?: string | string[]; plan?: string | string[]; error?: string | string[] };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const callbackURL = typeof query.callbackURL === "string" ? query.callbackURL : undefined;
  const plan = parsePlanParam(query.plan);
  const catalog = getPlanCatalog();
  const description = plan
    ? `Crie sua conta e siga direto para o plano ${catalog[plan].name}.`
    : `Comece com ${catalog.FREE.monthlyLimit.toLocaleString("pt-BR")} etiquetas por mês no plano gratuito.`;
  return (
    <AuthShell title="Crie sua conta" description={description}>
      <RegisterForm callbackURL={callbackURL} plan={plan} freePlan={choseFreePlan(query.plan)} googleEnabled={googleSignInEnabled()} initialError={oauthCallbackError(query.error)} />
    </AuthShell>
  );
}
