import type { Metadata } from "next";

import { AuthShell, RegisterForm } from "@/components/auth";

export const metadata: Metadata = { title: "Criar conta" };

export default function RegisterPage() {
  return (
    <AuthShell title="Crie sua conta" description="Comece com 10 etiquetas por mês no plano gratuito.">
      <RegisterForm />
    </AuthShell>
  );
}
