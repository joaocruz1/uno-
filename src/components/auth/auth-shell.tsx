import Image from "next/image";
import Link from "next/link";

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black px-4 py-12">
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(239,35,60,.18),transparent_34rem)]" />
      <div className="relative w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center gap-3" aria-label="UNO — página inicial">
          <Image src="/uno.svg" width={34} height={34} alt="" priority />
          <span className="font-heading text-2xl font-extrabold tracking-tight">UNO</span>
        </Link>
        <section className="rounded-2xl border border-white/[.08] bg-[#080808] p-6 shadow-2xl shadow-black sm:p-8">
          <h1 className="font-heading text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-400">{description}</p>
          <div className="mt-7">{children}</div>
        </section>
      </div>
    </main>
  );
}
