import type { Metadata } from "next";

import { AuthShell, ResetPasswordForm } from "@/components/auth";

export const metadata: Metadata = { title: "Redefinir senha" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const query = await searchParams;
  const token = typeof query.token === "string" && !query.error ? query.token : undefined;
  return (
    <AuthShell title="Defina uma nova senha" description="Use pelo menos 8 caracteres e escolha uma senha exclusiva para a UNO.">
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}
