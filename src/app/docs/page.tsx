import type { Metadata } from "next";

import { ApiReference } from "@/components/docs/api-reference";
import { getPlanCatalog } from "@/lib/plans";

export const metadata: Metadata = {
  title: "UNO API — Documentação",
  description: "Referência da API v1 da UNO: conversões, lotes, uso e webhooks. Autenticação Bearer, idempotência e webhooks assinados.",
};

export default function DocsPage() {
  const plans = getPlanCatalog();
  return <ApiReference rates={{ STARTER: plans.STARTER.rateLimit, PRO: plans.PRO.rateLimit, BUSINESS: plans.BUSINESS.rateLimit }} />;
}
