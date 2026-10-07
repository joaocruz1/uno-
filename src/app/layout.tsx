import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "UNO | Duas páginas. Uma etiqueta.", template: "%s | UNO" },
  description: "Recomponha uma etiqueta logística e uma DANFE em uma única página pronta para o seu fluxo de impressão.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
