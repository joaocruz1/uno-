import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import "./globals.css";

import { InlineScript } from "@/components/inline-script";

export const metadata: Metadata = {
  title: { default: "UNO | Duas páginas. Uma etiqueta.", template: "%s | UNO" },
  description: "Recomponha uma etiqueta logística e uma DANFE em uma única página pronta para o seu fluxo de impressão.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
};

// Set the dashboard theme before first paint so there is no flash. Defaults to
// light (the product's primary look); only an explicit choice flips it to dark.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('uno-theme');document.documentElement.setAttribute('data-theme',t==='dark'?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" data-theme="light" suppressHydrationWarning>
      <head>
        <InlineScript html={THEME_SCRIPT} />
      </head>
      <body>{children}</body>
    </html>
  );
}
