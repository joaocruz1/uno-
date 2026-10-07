export function Progress({ value, className, label }: { value: number; className?: string; label?: string }) {
  const safeValue = Math.max(0, Math.min(100, value));
  return (
    <div className={className}>
      {label ? <div className="mb-2 flex justify-between text-xs text-zinc-400"><span>{label}</span><span>{safeValue}%</span></div> : null}
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={safeValue} aria-label={label ?? "Progresso"}>
        <div className="h-full rounded-full bg-uno-red transition-[width]" style={{ width: `${safeValue}%` }} />
      </div>
    </div>
  );
}
