import { PageHeader, Pill } from "@/components/admin/insight-ui";
import { adminConnections } from "@/server/admin";
import { requireAdminPage } from "@/server/admin/page";

export const dynamic = "force-dynamic";

export default async function AdminConnectionsPage() {
  const connections = await adminConnections(await requireAdminPage());
  return (
    <div>
      <PageHeader kicker="Conexões" title="Serviços conectados" description="Quais provedores têm configuração presente neste ambiente. As credenciais ficam em variáveis de ambiente (.env.local aqui, cofre do provedor em produção) e nunca aparecem nesta tela." />
      <ul className="mt-8 grid gap-4 md:grid-cols-2">
        {connections.map((connection) => (
          <li key={connection.name} className="flex items-start justify-between gap-4 rounded-2xl border border-white/10 bg-[#080808] p-5">
            <div><p className="font-heading font-semibold">{connection.name}</p><p className="mt-1 text-sm text-zinc-500">{connection.purpose}</p><p className="mt-3 text-xs text-zinc-400">{connection.detail}</p></div>
            <Pill tone={connection.configured ? "good" : "muted"}>{connection.configured ? "Conectado" : "Não configurado"}</Pill>
          </li>
        ))}
      </ul>
      <p className="mt-6 max-w-2xl text-xs leading-5 text-zinc-500">“Conectado” significa que as variáveis existem, não que o provedor respondeu. Para a Stripe, valide também um pagamento de teste; veja docs/billing.md e docs/deploy.md.</p>
    </div>
  );
}
