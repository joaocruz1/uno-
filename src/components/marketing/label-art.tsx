import { cn } from "../ui/utils";

function Barcode({ compact = false }: { compact?: boolean }) {
  return <div className={cn("barcode", compact ? "h-6" : "h-9")} aria-hidden="true" />;
}

export function ShippingSheet({ className }: { className?: string }) {
  return (
    <div className={cn("label-sheet", className)} aria-label="Exemplo sintético de etiqueta logística">
      <div className="flex items-center justify-between border-b-2 border-black pb-1 text-[7px] font-black"><span>ENVIO</span><span>MLB000000000</span></div>
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2"><div><p className="text-[6px] font-bold">DESTINO</p><p className="mt-0.5 text-[11px] font-black leading-none">SP 01</p></div><div className="grid size-8 place-items-center border border-black text-[6px] font-black">QR</div></div>
      <div className="mt-2 border-y border-black py-1"><p className="text-[6px]">DESTINATÁRIO DE EXEMPLO</p><p className="text-[7px] font-bold">RUA MODELO, 100 · SÃO PAULO</p><p className="text-[6px]">00000-000</p></div>
      <Barcode />
      <p className="mt-1 text-center text-[6px] font-bold tracking-[.12em]">000 000 000 000</p>
    </div>
  );
}

export function DanfeSheet({ className }: { className?: string }) {
  return (
    <div className={cn("label-sheet", className)} aria-label="Exemplo sintético de DANFE simplificado">
      <div className="border-b-2 border-black pb-1"><p className="text-[8px] font-black">DANFE SIMPLIFICADO</p><p className="text-[5px]">DOCUMENTO AUXILIAR DA NOTA FISCAL</p></div>
      <div className="mt-2 grid grid-cols-2 gap-1 text-[5px]"><p><b>EMITENTE</b><br />EMPRESA MODELO LTDA.</p><p><b>NF-e</b><br />000000 · SÉRIE 1</p></div>
      <Barcode compact />
      <p className="mt-1 text-[5px]">CHAVE DE ACESSO</p><p className="text-[5px] font-bold">0000 0000 0000 0000 0000 0000</p>
      <div className="mt-2 border-t border-black pt-1 text-[5px]"><p><b>DESTINATÁRIO</b></p><p>CLIENTE DE EXEMPLO · SP</p></div>
      <div className="mt-2 h-5 border border-black p-1 text-[4px]">INFORMAÇÕES ADICIONAIS PRESERVADAS</div>
    </div>
  );
}

export function CombinedLabel({ className }: { className?: string }) {
  return (
    <div className={cn("label-sheet flex flex-col", className)} aria-label="Exemplo sintético de etiqueta unificada">
      <div className="flex items-center justify-between border-b-2 border-black pb-1 text-[7px] font-black"><span>ENVIO</span><span>SP 01</span></div>
      <div className="mt-1 grid grid-cols-[1fr_auto] gap-2"><div><p className="text-[5px]">DESTINATÁRIO DE EXEMPLO</p><p className="text-[7px] font-bold">RUA MODELO, 100</p><p className="text-[5px]">SÃO PAULO · 00000-000</p></div><div className="grid size-7 place-items-center border border-black text-[5px] font-black">QR</div></div>
      <Barcode compact />
      <div className="mt-1 border-t-2 border-black pt-1"><p className="text-[6px] font-black">DANFE SIMPLIFICADO</p><div className="mt-1 grid grid-cols-2 gap-1 text-[4px]"><p>EMPRESA MODELO LTDA.</p><p>NF-e 000000 · SÉRIE 1</p></div><Barcode compact /><p className="mt-1 text-[4px]">CHAVE 0000 0000 0000 0000 0000</p></div>
    </div>
  );
}
