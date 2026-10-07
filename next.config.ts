import type { NextConfig } from "next";

type HeaderEnvironment = Record<string, string | undefined>;

const POSTHOG_HOSTS = new Set(["us.i.posthog.com", "eu.i.posthog.com"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function invalid(variable: string): never {
  // Fail the build/start explicitly: a mistyped origin must not silently weaken or break the policy.
  throw new Error(`Invalid ${variable} for the Content-Security-Policy.`);
}

function parseOrigin(value: string, allowPlainHttp: boolean): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const plainHttpAllowed = url.protocol === "http:" && (allowPlainHttp || LOCAL_HOSTS.has(url.hostname));
  if ((url.protocol !== "https:" && !plainHttpAllowed) || url.username || url.password || url.search || url.hash) return null;
  return url;
}

/** Origins the browser must reach directly for signed uploads, previews and downloads. */
function storageOrigins(environment: HeaderEnvironment, development: boolean): string[] {
  const origins: string[] = [];
  const endpoint = environment.S3_ENDPOINT?.trim();
  // An endpoint the policy cannot express is skipped here (the caller falls back
  // to a functional policy); storage itself reports its own configuration errors.
  const url = endpoint ? parseOrigin(endpoint, development) : null;
  if (url) {
    origins.push(url.origin);
    const bucket = environment.S3_BUCKET?.trim();
    const pathStyle = LOCAL_HOSTS.has(url.hostname) || environment.S3_FORCE_PATH_STYLE === "true";
    if (bucket && !pathStyle && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      origins.push(`${url.protocol}//${bucket}.${url.host}`);
    }
  }
  for (const entry of (environment.UNO_CSP_CONNECT_SRC ?? "").split(/[\s,]+/).filter(Boolean)) {
    const extra = parseOrigin(entry, false);
    if (!extra || extra.pathname !== "/") return invalid("UNO_CSP_CONNECT_SRC");
    origins.push(extra.origin);
  }
  return [...new Set(origins)];
}

function analyticsOrigins(environment: HeaderEnvironment): string[] {
  // PostHog is only reachable when a key is configured, and only on the hosts the client itself accepts.
  if (!environment.NEXT_PUBLIC_POSTHOG_KEY?.trim()) return [];
  try {
    const url = new URL(environment.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com");
    return url.protocol === "https:" && !url.port && POSTHOG_HOSTS.has(url.hostname) ? [url.origin] : [];
  } catch {
    return [];
  }
}

export function contentSecurityPolicy(environment: HeaderEnvironment = process.env): string {
  const development = environment.NODE_ENV !== "production";
  const storage = storageOrigins(environment, development);
  // Headers are fixed when the server is built. Without a known storage origin
  // the policy stays functional by allowing any HTTPS endpoint for fetches only.
  const connect = ["'self'", ...(storage.length ? storage : ["https:"]), ...analyticsOrigins(environment)];
  if (development) connect.push("ws:", "wss:", ...(storage.length ? [] : ["http:"]));
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    // Next.js bootstraps with inline scripts and no nonce is issued; PDF.js decoders need WebAssembly.
    ["script-src", ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", ...(development ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", connect],
    ["worker-src", ["'self'", "blob:"]],
    ["frame-src", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  const policy = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!development) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

export function securityHeaders(environment: HeaderEnvironment = process.env): Array<{ key: string; value: string }> {
  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(environment) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), browsing-topics=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];
  if (environment.NODE_ENV === "production") {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" });
  }
  return headers;
}

const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist", "bullmq", "ioredis"],
  poweredByHeader: false,
  experimental: { turbopackFileSystemCacheForDev: process.env.UNO_DISABLE_DEV_DISK_CACHE !== "true" },
  logging: { incomingRequests: false, serverFunctions: false, browserToTerminal: false, fetches: { fullUrl: false } },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
};
export default config;
