import type { Metadata } from "next";

import { AuthShell, ForgotPasswordForm } from "@/components/auth";

export const metadata: Metadata = { title: "Recuperar senha" };

export default function ForgotPasswordPage() {
  return (
    <AuthShell title="Recupere sua senha" description="Informe seu e-mail e enviaremos um link seguro para criar uma nova senha.">
      <ForgotPasswordForm />
    </AuthShell>
  );
}
