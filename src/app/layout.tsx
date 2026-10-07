import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "UNO | Duas páginas. Uma etiqueta.", description: "Una etiquetas e DANFEs em uma etiqueta pronta para impressão." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR"><body>{children}</body></html>; }
