import type { Metadata } from "next";

import { ShopeeListFlow } from "@/components/marketplace/shopee-list-flow";
import { requireActor } from "@/server/http";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lista de separação — Shopee",
};

export default async function ShopeeListPage() {
  await requireActor();

  return (
    <div className="mx-auto max-w-6xl">
      <header className="max-w-2xl">
        <h1 className="font-heading text-3xl font-extrabold tracking-tight text-[var(--color-ink)] sm:text-4xl">Lista de separação da Shopee</h1>
        <p className="mt-3 text-sm leading-6 text-[var(--color-muted)] sm:text-base">Suba a planilha de embalagem da Shopee e baixe a lista de separação do dia — somada por SKU, por pedido ou agrupada, em 10×15 ou A4.</p>
      </header>

      <div className="mt-8">
        <ShopeeListFlow />
      </div>
    </div>
  );
}
