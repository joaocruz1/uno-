import Image from "next/image";
import Link from "next/link";

const columns = [
  { title: "Produto", links: [["Como funciona", "/#como-funciona"], ["Preços", "/pricing"], ["API", "/api"]] },
  { title: "Recursos", links: [["Documentação", "/docs"], ["Status", "/docs#status"], ["Segurança", "/#seguranca"]] },
  { title: "Legal", links: [["Privacidade", "/privacy"], ["Termos de uso", "/terms"]] },
] as const;

export function Footer() {
  return (
    <footer className="border-t border-white/[.07] bg-[#030303]">
      <div className="page-shell grid gap-12 py-14 md:grid-cols-[1.3fr_2fr]">
        <div>
          <Link href="/" className="inline-flex items-center gap-3"><Image src="/uno.svg" width={30} height={30} alt="" /><span className="font-heading text-xl font-extrabold tracking-[-.05em]">UNO</span></Link>
          <p className="mt-4 max-w-xs text-sm leading-6 text-zinc-500">Etiquetas logísticas e DANFEs recompostas em uma página pronta para o seu fluxo de impressão.</p>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {columns.map((column) => <div key={column.title}><p className="text-sm font-semibold text-white">{column.title}</p><ul className="mt-4 space-y-3">{column.links.map(([label, href]) => <li key={href}><Link className="text-sm text-zinc-500 hover:text-white" href={href}>{label}</Link></li>)}</ul></div>)}
        </div>
      </div>
      <div className="page-shell flex flex-col gap-2 border-t border-white/[.06] py-6 text-xs text-zinc-600 sm:flex-row sm:items-center sm:justify-between"><span>© {new Date().getFullYear()} UNO.</span><span>Feito para operações que imprimem todos os dias.</span></div>
    </footer>
  );
}
