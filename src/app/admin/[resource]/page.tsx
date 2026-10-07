import { notFound } from "next/navigation";

import { AdminTable, type AdminResource } from "@/components/admin/admin-table";
import { requireAdminPage } from "@/server/admin/page";

const PAGES: Record<AdminResource, { title: string; description: string }> = {
  organizations: { title: "Organizações", description: "Identificadores, plano e quantidade de membros de cada organização." },
  subscriptions: { title: "Assinaturas", description: "Plano, estado e período vigente. Alterações de cobrança acontecem somente pelo provedor." },
  usage: { title: "Uso", description: "Limite, reservas e confirmações por período. A cota não é editável aqui." },
  conversions: { title: "Conversões", description: "Estado, versões, formato e tempos. Arquivos e nomes de documentos não são exibidos." },
  failures: { title: "Falhas", description: "Conversões com falha terminal e o código seguro do erro." },
  jobs: { title: "Jobs", description: "Eventos duráveis do outbox, com estado e tentativas. O conteúdo dos eventos não é exibido." },
};

export default async function AdminResourcePage({ params }: { params: Promise<{ resource: string }> }) {
  await requireAdminPage();
  const { resource } = await params;
  if (!Object.hasOwn(PAGES, resource)) notFound();
  const page = PAGES[resource as AdminResource];
  return (
    <div>
      <p className="text-sm font-semibold text-uno-red">Somente metadados</p>
      <h1 className="mt-2 font-heading text-3xl font-bold">{page.title}</h1>
      <p className="mt-3 max-w-2xl text-zinc-400">{page.description}</p>
      <AdminTable key={resource} resource={resource as AdminResource} />
    </div>
  );
}
