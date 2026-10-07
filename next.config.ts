import type { NextConfig } from "next";
const config: NextConfig = { output: "standalone", serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist", "bullmq", "ioredis"], poweredByHeader: false, experimental: { turbopackFileSystemCacheForDev: process.env.UNO_DISABLE_DEV_DISK_CACHE !== "true" }, logging: { incomingRequests: false, serverFunctions: false, browserToTerminal: false, fetches: { fullUrl: false } } };
export default config;
