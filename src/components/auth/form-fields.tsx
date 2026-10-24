"use client";

export function Field({
  label,
  name,
  type = "text",
  autoComplete,
  minLength,
  required = true,
  placeholder,
  defaultValue,
  readOnly,
}: {
  label: string;
  name: string;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  readOnly?: boolean;
}) {
  return (
    <label className="block text-sm font-medium text-zinc-200">
      {label}
      <input
        className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-white/[.04] px-3 text-base text-white outline-none transition placeholder:text-zinc-600 focus:border-uno-red focus:ring-2 focus:ring-uno-red/20"
        name={name}
        type={type}
        autoComplete={autoComplete}
        minLength={minLength}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        readOnly={readOnly}
      />
    </label>
  );
}

export function SubmitButton({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex h-11 w-full items-center justify-center rounded-lg bg-uno-red px-4 text-sm font-bold text-white transition hover:bg-[#ff334d] disabled:cursor-wait disabled:opacity-60"
    >
      {pending ? "Aguarde…" : children}
    </button>
  );
}

export function FormMessage({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null;
  return (
    <p role={error ? "alert" : "status"} className={`rounded-lg border px-3 py-2.5 text-sm ${error ? "border-red-500/25 bg-red-500/10 text-red-200" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"}`}>
      {error ?? success}
    </p>
  );
}
