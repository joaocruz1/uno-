import { DataTable, dateTime, integer, PageHeader, Pill, Stat } from "@/components/admin/insight-ui";
import { adminApiKeys } from "@/server/admin";
import { requireAdminPage } from "@/server/admin/page";

export const dynamic = "force-dynamic";

const STATE = { active: ["good", "Ativa"], revoked: ["bad", "Revogada"], expired: ["muted", "Expirada"] } as const;

export default async function AdminApiKeysPage() {
  const keys = await adminApiKeys(await requireAdminPage());
  const active = keys.filter((key) => key.state === "active");
  return (
    <div>
      <PageHeader kicker="Integrações" title="Chaves de API" description="Quem integrou via API e quanto cada chave está sendo usada. O segredo da chave nunca é armazenado nem exibido; só o prefixo público." />
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Chaves ativas" value={integer(active.length)} />
        <Stat label="Organizações integradas" value={integer(new Set(active.map((key) => key.organizationId)).size)} />
        <Stat label="Requisições em 30 dias" value={integer(keys.reduce((total, key) => total + key.requests30d, 0))} hint={`${integer(keys.reduce((total, key) => total + key.conversions30d, 0))} etiquetas criadas via API`} />
      </div>
      <div className="mt-8">
        <DataTable empty="Nenhuma chave de API foi criada." columns={["Organização", "Chave", "Estado", "Requisições 30 d", "Etiquetas 30 d", "Último uso", "Criada em"]} rows={keys.map((key) => [
          <div key="o"><p className="font-medium text-white">{key.organizationName}</p><p className="text-xs text-zinc-500">Plano {key.planId}</p></div>,
          <div key="k"><p>{key.name}</p><p className="font-mono text-xs text-zinc-500">{key.prefix}…</p></div>,
          <Pill key="s" tone={STATE[key.state][0]}>{STATE[key.state][1]}</Pill>,
          integer(key.requests30d),
          integer(key.conversions30d),
          dateTime(key.lastUsedAt),
          dateTime(key.createdAt),
        ])} />
      </div>
    </div>
  );
}
