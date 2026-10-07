import type { NextConfig } from "next";
const config: NextConfig = { output: "standalone", serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"], poweredByHeader: false };
export default config;
