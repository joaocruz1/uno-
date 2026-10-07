import { createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { globalAgent, type RequestOptions } from "node:https";

import { describe, expect, it } from "vitest";

import { webhookMaxActiveEndpoints, webhookTimeoutMs } from "@/server/webhooks/config";
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  loadWebhookKeyring,
  signWebhookBody,
  type WebhookKeyring,
} from "@/server/webhooks/crypto";
import {
  assertWebhookDestinationAllowed,
  createPinnedHttpsConnector,
  isPublicAddress,
  parseWebhookUrl,
  resolvePinnedAddress,
  sendWebhookRequest,
  type PinnedRequest,
  type ResolvedAddress,
} from "@/server/webhooks/network";

const ORG = "00000000-0000-4000-8000-000000000201";
const OTHER_ORG = "00000000-0000-4000-8000-000000000202";
const ENDPOINT = "00000000-0000-4000-8000-000000000301";
const PUBLIC_V4: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6: ResolvedAddress = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };

function keyring(version = "v1"): WebhookKeyring {
  return { currentVersion: version, keys: new Map([[version, randomBytes(32)]]) };
}

describe("webhook secret encryption", () => {
  const binding = { organizationId: ORG, endpointId: ENDPOINT };

  it("round-trips with AES-256-GCM, a unique IV per secret and no plaintext at rest", () => {
    const keys = keyring();
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const first = encryptWebhookSecret(secret, binding, keys);
    const second = encryptWebhookSecret(secret, binding, keys);
    expect(first.encryptionKeyVersion).toBe("v1");
    expect(Buffer.from(first.secretIv, "base64")).toHaveLength(12);
    expect(Buffer.from(first.secretAuthTag, "base64")).toHaveLength(16);
    expect(first.secretIv).not.toBe(second.secretIv);
    expect(first.secretCiphertext).not.toBe(second.secretCiphertext);
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(decryptWebhookSecret(first, binding, keys)).toBe(secret);
  });

  it("fails closed on tampering and on a different organization or endpoint (AAD)", () => {
    const keys = keyring();
    const encrypted = encryptWebhookSecret(generateWebhookSecret(), binding, keys);
    const flip = (value: string) => {
      const bytes = Buffer.from(value, "base64");
      bytes[0] = bytes[0]! ^ 0x01;
      return bytes.toString("base64");
    };
    const failure = { code: "webhook_secret_unavailable" };
    expect(() => decryptWebhookSecret({ ...encrypted, secretCiphertext: flip(encrypted.secretCiphertext) }, binding, keys)).toThrowError(expect.objectContaining(failure));
    expect(() => decryptWebhookSecret({ ...encrypted, secretAuthTag: flip(encrypted.secretAuthTag) }, binding, keys)).toThrowError(expect.objectContaining(failure));
    expect(() => decryptWebhookSecret({ ...encrypted, secretIv: flip(encrypted.secretIv) }, binding, keys)).toThrowError(expect.objectContaining(failure));
    expect(() => decryptWebhookSecret({ ...encrypted, secretAuthTag: "AAAA" }, binding, keys)).toThrowError(expect.objectContaining(failure));
    expect(() => decryptWebhookSecret(encrypted, { ...binding, organizationId: OTHER_ORG }, keys)).toThrowError(expect.objectContaining(failure));
    expect(() => decryptWebhookSecret(encrypted, { ...binding, endpointId: "00000000-0000-4000-8000-000000000399" }, keys)).toThrowError(expect.objectContaining(failure));
    expect(() => decryptWebhookSecret(encrypted, binding, keyring())).toThrowError(expect.objectContaining(failure));
  });

  it("decrypts by the stored key version after rotation and rejects unknown versions", () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const before = loadWebhookKeyring({ NODE_ENV: "test", WEBHOOK_ENCRYPTION_KEY: oldKey.toString("base64") });
    expect(before.currentVersion).toBe("v1");
    const secret = generateWebhookSecret();
    const stored = encryptWebhookSecret(secret, binding, before);

    const rotated = loadWebhookKeyring({
      NODE_ENV: "test",
      WEBHOOK_ENCRYPTION_KEY: newKey.toString("hex"),
      WEBHOOK_ENCRYPTION_KEY_VERSION: "v2",
      WEBHOOK_ENCRYPTION_KEY_V1: oldKey.toString("base64url"),
    });
    expect(rotated.currentVersion).toBe("v2");
    expect(decryptWebhookSecret(stored, binding, rotated)).toBe(secret);
    expect(encryptWebhookSecret(secret, binding, rotated).encryptionKeyVersion).toBe("v2");

    const withoutOld = loadWebhookKeyring({ NODE_ENV: "test", WEBHOOK_ENCRYPTION_KEY: newKey.toString("hex"), WEBHOOK_ENCRYPTION_KEY_VERSION: "v2" });
    expect(() => decryptWebhookSecret(stored, binding, withoutOld)).toThrowError(expect.objectContaining({ code: "webhook_secret_unavailable" }));
  });

  it("rejects missing or malformed keys and invalid security settings explicitly", () => {
    expect(() => loadWebhookKeyring({ NODE_ENV: "test" })).toThrowError(expect.objectContaining({ code: "service_unavailable" }));
    expect(() => loadWebhookKeyring({ NODE_ENV: "test", WEBHOOK_ENCRYPTION_KEY: "too-short" })).toThrowError(expect.objectContaining({ code: "service_unavailable" }));
    expect(() => loadWebhookKeyring({ NODE_ENV: "test", WEBHOOK_ENCRYPTION_KEY: randomBytes(32).toString("hex"), WEBHOOK_ENCRYPTION_KEY_VERSION: "V 1" }))
      .toThrowError(expect.objectContaining({ code: "service_unavailable" }));
    expect(webhookTimeoutMs({ NODE_ENV: "test" })).toBe(10_000);
    expect(webhookTimeoutMs({ NODE_ENV: "test", UNO_WEBHOOK_TIMEOUT_MS: "2500" })).toBe(2_500);
    expect(() => webhookTimeoutMs({ NODE_ENV: "test", UNO_WEBHOOK_TIMEOUT_MS: "0" })).toThrowError(expect.objectContaining({ code: "service_unavailable" }));
    expect(() => webhookTimeoutMs({ NODE_ENV: "test", UNO_WEBHOOK_TIMEOUT_MS: "abc" })).toThrowError(expect.objectContaining({ code: "service_unavailable" }));
    expect(webhookMaxActiveEndpoints({ NODE_ENV: "test" })).toBe(10);
    expect(() => webhookMaxActiveEndpoints({ NODE_ENV: "test", UNO_WEBHOOK_MAX_ACTIVE_ENDPOINTS: "-1" })).toThrowError(expect.objectContaining({ code: "service_unavailable" }));
  });

  it("signs '<timestamp>.<exact body>' as lowercase hex HMAC-SHA256", () => {
    const body = "{\"id\":\"evt\",\"data\":{\"a\":1}}";
    const expected = createHmac("sha256", "whsec_test").update(`1791374400.${body}`, "utf8").digest("hex");
    expect(signWebhookBody("whsec_test", 1_791_374_400, body)).toBe(`v1=${expected}`);
    expect(signWebhookBody("whsec_test", 1_791_374_400, body)).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(signWebhookBody("whsec_test", 1_791_374_400, `${body} `)).not.toBe(`v1=${expected}`);
    expect(signWebhookBody("whsec_test", 1_791_374_401, body)).not.toBe(`v1=${expected}`);
  });
});

describe("webhook URL policy", () => {
  it("accepts only public HTTPS hostnames on port 443", () => {
    expect(parseWebhookUrl("https://receiver.example.com/hooks/uno?tenant=1")).toEqual({
      href: "https://receiver.example.com/hooks/uno?tenant=1",
      hostname: "receiver.example.com",
      path: "/hooks/uno?tenant=1",
    });
    expect(parseWebhookUrl("https://RECEIVER.example.com:443").href).toBe("https://receiver.example.com/");
  });

  it.each([
    "http://receiver.example.com/hook",
    "ftp://receiver.example.com/hook",
    "https://receiver.example.com:8443/hook",
    "https://receiver.example.com:80/hook",
    "https://user:pass@receiver.example.com/hook",
    "https://user@receiver.example.com/hook",
    "https://receiver.example.com/hook#fragment",
    "https://receiver.example.com/hook#",
    "https://127.0.0.1/hook",
    "https://8.8.8.8/hook",
    "https://2130706433/hook",
    "https://0x7f.0.0.1/hook",
    "https://0177.0.0.1/hook",
    "https://127.1/hook",
    "https://[::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
    "https://[2606:2800:220:1:248:1893:25c8:1946]/hook",
    "https://localhost/hook",
    "https://app.localhost/hook",
    "https://intranet/hook",
    "https://db.internal/hook",
    "https://printer.local/hook",
    "https://service.corp/hook",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://receiver.example.com./hook",
    "https://receiver.example.com\\@127.0.0.1/hook",
    "https://receiver.example.com/ho ok",
    "//receiver.example.com/hook",
    "receiver.example.com/hook",
    "",
    `https://receiver.example.com/${"a".repeat(2_100)}`,
  ])("rejects %s", (url) => {
    expect(() => parseWebhookUrl(url)).toThrowError(expect.objectContaining({ code: "invalid_webhook_url" }));
  });
});

describe("webhook SSRF address guard", () => {
  it.each([
    "0.0.0.0", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.254",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.10", "192.88.99.1", "192.168.1.1",
    "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1",
    "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::127.0.0.1",
    "64:ff9b::7f00:1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "ff0e::1",
    "2001::1", "2001:db8::1", "2002:7f00:1::1", "100::1", "3fff::1",
    "not-an-ip", "", "8.8.8.8.8",
  ])("denies %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:2800:220:1:248:1893:25c8:1946", "2a00:1450:4001:81b::200e"])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("requires the declared family to match the address", () => {
    expect(isPublicAddress("8.8.8.8", 6)).toBe(false);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946", 4)).toBe(false);
  });

  it("validates every A/AAAA record and refuses mixed answers", async () => {
    await expect(resolvePinnedAddress("receiver.example.com", async () => [PUBLIC_V6, PUBLIC_V4], 1_000)).resolves.toEqual(PUBLIC_V4);
    await expect(resolvePinnedAddress("receiver.example.com", async () => [PUBLIC_V6], 1_000)).resolves.toEqual(PUBLIC_V6);
    await expect(resolvePinnedAddress("receiver.example.com", async () => [PUBLIC_V4, { address: "10.0.0.5", family: 4 }], 1_000))
      .rejects.toMatchObject({ code: "destination_not_allowed" });
    await expect(resolvePinnedAddress("receiver.example.com", async () => [PUBLIC_V4, { address: "::ffff:169.254.169.254", family: 6 }], 1_000))
      .rejects.toMatchObject({ code: "destination_not_allowed" });
    await expect(resolvePinnedAddress("receiver.example.com", async () => [{ address: "8.8.8.8", family: 6 }], 1_000))
      .rejects.toMatchObject({ code: "destination_not_allowed" });
    await expect(resolvePinnedAddress("receiver.example.com", async () => [], 1_000)).rejects.toMatchObject({ code: "dns_failed" });
    await expect(resolvePinnedAddress("receiver.example.com", async () => { throw new Error("ENOTFOUND receiver.example.com"); }, 1_000))
      .rejects.toMatchObject({ code: "dns_failed", message: "dns_failed" });
    await expect(resolvePinnedAddress("receiver.example.com", () => new Promise(() => undefined), 20)).rejects.toMatchObject({ code: "timeout" });
  });

  it("applies the same guard at registration without echoing the destination", async () => {
    await expect(assertWebhookDestinationAllowed("https://receiver.example.com/hook", async () => [PUBLIC_V4], 1_000))
      .resolves.toMatchObject({ hostname: "receiver.example.com" });
    const denied = assertWebhookDestinationAllowed("https://receiver.example.com/hook", async () => [{ address: "192.168.0.10", family: 4 }], 1_000);
    await expect(denied).rejects.toMatchObject({ code: "webhook_destination_not_allowed", status: 400 });
    await denied.catch((error: Error) => {
      expect(error.message).not.toContain("receiver.example.com");
      expect(error.message).not.toContain("192.168");
    });
  });
});

describe("webhook send pipeline with injected transport", () => {
  const input = { url: "https://receiver.example.com/hooks/uno?x=1", headers: { "x-label-delivery": "d1" }, body: "{}", timeoutMs: 1_000 };

  it("keeps production validation active even when the socket layer is injected", async () => {
    let connects = 0;
    const connect = async () => { connects += 1; return { status: 200 }; };
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "::ffff:10.0.0.1"]) {
      const family = address.includes(":") ? 6 : 4;
      await expect(sendWebhookRequest(input, { resolve: async () => [{ address, family }], connect }))
        .rejects.toMatchObject({ code: "destination_not_allowed" });
    }
    await expect(sendWebhookRequest({ ...input, url: "https://127.0.0.1/hook" }, { resolve: async () => [PUBLIC_V4], connect }))
      .rejects.toMatchObject({ code: "invalid_url" });
    await expect(sendWebhookRequest({ ...input, url: "http://receiver.example.com/hook" }, { resolve: async () => [PUBLIC_V4], connect }))
      .rejects.toMatchObject({ code: "invalid_url" });
    expect(connects).toBe(0);
  });

  it("pins the validated IP so DNS rebinding between validation and connect has no effect", async () => {
    const answers: ResolvedAddress[][] = [[PUBLIC_V4], [{ address: "127.0.0.1", family: 4 }]];
    let lookups = 0;
    const seen: PinnedRequest[] = [];
    const result = await sendWebhookRequest(input, {
      resolve: async () => { lookups += 1; return answers.shift() ?? [{ address: "127.0.0.1", family: 4 }]; },
      connect: async (request) => { seen.push(request); return { status: 204 }; },
    });
    expect(result).toEqual({ status: 204 });
    expect(lookups).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      address: PUBLIC_V4.address, family: 4, port: 443, hostname: "receiver.example.com", path: "/hooks/uno?x=1", body: "{}", maxResponseBytes: 65_536,
    });
    // The next send resolves again, sees the rebound private address and refuses.
    await expect(sendWebhookRequest(input, {
      resolve: async () => { lookups += 1; return answers.shift() ?? []; },
      connect: async (request) => { seen.push(request); return { status: 204 }; },
    })).rejects.toMatchObject({ code: "destination_not_allowed" });
    expect(seen).toHaveLength(1);
  });

  it("maps a hanging connector to a timeout and unknown failures to a safe code", async () => {
    await expect(sendWebhookRequest({ ...input, timeoutMs: 30 }, { resolve: async () => [PUBLIC_V4], connect: () => new Promise(() => undefined) }))
      .rejects.toMatchObject({ code: "timeout" });
    const failure = sendWebhookRequest(input, { resolve: async () => [PUBLIC_V4], connect: async () => { throw new Error("connect ECONNREFUSED https://receiver.example.com/hooks/uno?x=1"); } });
    await expect(failure).rejects.toMatchObject({ code: "network_error", message: "network_error" });
  });
});

class FakeResponse extends EventEmitter {
  constructor(readonly statusCode: number, readonly headers: Record<string, string> = {}) { super(); }
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  sent: string | undefined;
  constructor(private readonly onEnd: (request: FakeRequest) => void) { super(); }
  end(body: string) { this.sent = body; queueMicrotask(() => this.onEnd(this)); return this; }
  destroy() { this.destroyed = true; return this; }
}

function fakeFactory(onEnd: (request: FakeRequest) => void) {
  const calls: { options: RequestOptions; request: FakeRequest }[] = [];
  const factory = (options: RequestOptions) => {
    const request = new FakeRequest(onEnd);
    calls.push({ options, request });
    return request as unknown as ClientRequest;
  };
  return { calls, factory };
}

describe("pinned HTTPS connector", () => {
  const target: PinnedRequest = {
    address: PUBLIC_V4.address,
    family: 4,
    port: 443,
    hostname: "receiver.example.com",
    path: "/hooks/uno",
    headers: { "content-type": "application/json; charset=utf-8", "x-label-delivery": "d1" },
    body: "{\"ok\":true}",
    timeoutMs: 1_000,
    maxResponseBytes: 65_536,
  };

  it("dials the pinned IP while keeping Host/SNI, with a dedicated agent that ignores proxies", async () => {
    const { calls, factory } = fakeFactory((request) => {
      const response = new FakeResponse(200);
      request.emit("response", response);
      response.emit("end");
    });
    await expect(createPinnedHttpsConnector(factory)(target)).resolves.toEqual({ status: 200 });
    expect(calls).toHaveLength(1);
    const { options, request } = calls[0]!;
    expect(options).toMatchObject({
      host: PUBLIC_V4.address, family: 4, port: 443, servername: "receiver.example.com", method: "POST", path: "/hooks/uno", rejectUnauthorized: true,
    });
    expect(options.headers).toMatchObject({ host: "receiver.example.com", "x-label-delivery": "d1" });
    expect(options.agent).toBeDefined();
    expect(options.agent).not.toBe(globalAgent);
    expect(options.agent).not.toBe(false);
    expect(request.sent).toBe(target.body);
    expect(request.destroyed).toBe(true);
  });

  it("refuses non-public addresses and other ports before opening a socket", async () => {
    const { calls, factory } = fakeFactory(() => undefined);
    const connect = createPinnedHttpsConnector(factory);
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1"]) {
      await expect(connect({ ...target, address })).rejects.toMatchObject({ code: "destination_not_allowed" });
    }
    await expect(connect({ ...target, address: "::ffff:127.0.0.1", family: 6 })).rejects.toMatchObject({ code: "destination_not_allowed" });
    await expect(connect({ ...target, port: 8443 as unknown as 443 })).rejects.toMatchObject({ code: "destination_not_allowed" });
    expect(calls).toHaveLength(0);
  });

  it("never follows redirects", async () => {
    const { calls, factory } = fakeFactory((request) => {
      const response = new FakeResponse(302, { location: "https://169.254.169.254/latest/meta-data/" });
      request.emit("response", response);
      response.emit("end");
    });
    await expect(createPinnedHttpsConnector(factory)(target)).resolves.toEqual({ status: 302 });
    expect(calls).toHaveLength(1);
  });

  it("stops reading once the response passes the 64 KiB cap", async () => {
    let delivered = 0;
    const { calls, factory } = fakeFactory((request) => {
      const response = new FakeResponse(200);
      request.emit("response", response);
      for (let index = 0; index < 100 && !request.destroyed; index += 1) {
        delivered += 1;
        response.emit("data", Buffer.alloc(16 * 1_024));
      }
    });
    await expect(createPinnedHttpsConnector(factory)(target)).resolves.toEqual({ status: 200 });
    expect(calls[0]!.request.destroyed).toBe(true);
    expect(delivered).toBe(5);
  });

  it("times out when the receiver never answers and maps socket errors to safe codes", async () => {
    const silent = fakeFactory(() => undefined);
    await expect(createPinnedHttpsConnector(silent.factory)({ ...target, timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
    expect(silent.calls[0]!.request.destroyed).toBe(true);

    const slowBody = fakeFactory((request) => { request.emit("response", new FakeResponse(200)); });
    await expect(createPinnedHttpsConnector(slowBody.factory)({ ...target, timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });

    const reset = fakeFactory((request) => { request.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })); });
    await expect(createPinnedHttpsConnector(reset.factory)(target)).rejects.toMatchObject({ code: "network_error", message: "network_error" });

    const certificate = fakeFactory((request) => { request.emit("error", Object.assign(new Error("bad cert"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })); });
    await expect(createPinnedHttpsConnector(certificate.factory)(target)).rejects.toMatchObject({ code: "tls_error" });
  });
});
