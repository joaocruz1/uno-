export function LoadingState({ label = "Carregando" }: { label?: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center gap-3 text-sm text-zinc-400" role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-zinc-700 border-t-uno-red motion-reduce:animate-none" />
      <span>{label}</span>
    </div>
  );
}
