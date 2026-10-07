import { TemplateReleasePanel } from "@/components/admin/template-release-panel";
import { requireAdminPage } from "@/server/admin/page";

export default async function AdminTemplatesPage() {
  await requireAdminPage();
  return (
    <div>
      <p className="text-sm font-semibold text-uno-red">Liberação por prova física</p>
      <h1 className="mt-2 font-heading text-3xl font-bold">Modelos</h1>
      <p className="mt-3 max-w-2xl text-zinc-400">Cada combinação de modelo e tamanho só entra em produção com o relatório automático aprovado e a prova física registrada pelo operador.</p>
      <TemplateReleasePanel />
    </div>
  );
}
