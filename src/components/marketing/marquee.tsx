const items: Array<readonly [string, boolean]> = [
  ["Mercado Livre", true], ["Shopee", false], ["Shein", false], ["Amazon", false],
  ["Magalu", false], ["Correios", false], ["Jadlog", false], ["Loggi", false],
];

/** Template roadmap strip. Only the first layout is available; the rest are labelled as upcoming. */
export function TemplateMarquee() {
  const row = (hidden: boolean) => (
    <ul className="marquee-track flex shrink-0 items-center gap-10 pr-10" aria-hidden={hidden || undefined}>
      {items.map(([name, available]) => (
        <li key={name} className="flex items-center gap-3 whitespace-nowrap font-heading text-lg font-bold text-zinc-500">
          <span className={available ? "text-white" : ""}>{name}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${available ? "border-uno-red/40 bg-uno-red/10 text-red-200" : "border-white/10 text-zinc-600"}`}>{available ? "Disponível" : "Em breve"}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="marquee relative flex overflow-hidden border-y border-white/[.06] bg-black py-5" aria-label="Templates de etiqueta">
      {row(false)}{row(true)}
    </div>
  );
}
