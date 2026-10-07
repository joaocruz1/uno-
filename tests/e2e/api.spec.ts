import { expect, test, type Page } from "@playwright/test";

import { closeDb } from "@/db";
import { mailLink } from "./helpers/mail";
import { promoteSyntheticPro, restoreSyntheticFree } from "./helpers/api-fixture";

test.use({ trace: "off", video: "off", screenshot: "off" });

test.afterAll(async () => {
  if (process.env.UNO_LOCAL_API_E2E === "1") await closeDb();
});

async function verifiedPage(page: Page): Promise<string> {
  const origin = "http://127.0.0.1:3100";
  const email = `uno-api-e2e-${crypto.randomUUID()}@example.test`;
  let signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: { name: "Operador API", email, password: "Api-key-e2e-password", callbackURL: "/verify-email?verified=1" },
  });
  for (let attempt = 0; signup.status() === 429 && attempt < 8; attempt += 1) {
    const retryAfter = Number(signup.headers()["retry-after"]);
    await page.waitForTimeout(Math.min(30_000, Math.max(1_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 5_000)));
    signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
      headers: { origin },
      data: { name: "Operador API", email, password: "Api-key-e2e-password", callbackURL: "/verify-email?verified=1" },
    });
  }
  expect(signup.status()).toBe(200);
  await page.goto(await mailLink(page.request, email, "verify-email"));
  return email;
}

test("free API page is plan-gated and never exposes a key creation form", async ({ page }) => {
  test.skip(process.env.UNO_LOCAL_AUTH_E2E !== "1", "Requires local PostgreSQL and Mailpit");
  test.setTimeout(120_000);
  await verifiedPage(page);
  await page.goto("/dashboard/api");
  await expect(page.getByRole("heading", { name: "API", exact: true })).toBeVisible();
  await expect(page.getByText("A API está disponível nos planos Pro e Business.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Consultar planos", exact: true })).toHaveAttribute("href", "/dashboard/billing");
  await expect(page.getByText("Nenhuma chave criada", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Nome da integração", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Criar chave", exact: true })).toHaveCount(0);
});

test("paid API key is shown once, authenticates usage, and revokes", async ({ page }) => {
    test.skip(process.env.UNO_LOCAL_API_E2E !== "1", "Requires local PostgreSQL, Mailpit and a local API fixture");
    test.setTimeout(120_000);
    const email = await verifiedPage(page);
    await page.goto("/dashboard");
    const { organizationId } = await promoteSyntheticPro(email);
    let secret = "";
    try {
      await page.goto("/dashboard/api");
      const nameInput = page.getByLabel("Nome da integração", { exact: true });
      await nameInput.fill("syntheticERP");
      await page.getByRole("button", { name: "Criar chave", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      const secretInput = page.getByLabel("Chave de API criada", { exact: true });
      secret = await secretInput.inputValue();
      expect(secret.length).toBeGreaterThan(40);
      await page.getByRole("button", { name: "Concluído", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(nameInput).toBeFocused();
      await page.reload();
      await expect(page.getByText("syntheticERP", { exact: true })).toBeVisible();
      const bodyText = await page.locator("body").textContent();
      expect(Boolean(bodyText?.includes(secret))).toBe(false);

      const beforeRevoke = await page.request.get("/api/v1/usage", { headers: { authorization: `Bearer ${secret}` } });
      expect(beforeRevoke.status()).toBe(200);
      const usage = await beforeRevoke.json();
      expect(usage.planId).toBe("PRO");
      for (const field of ["limit", "reserved", "confirmed", "remaining"] as const) {
        expect(Number.isInteger(usage[field])).toBe(true);
      }
      expect(typeof usage.periodStart).toBe("string");
      expect(typeof usage.periodEnd).toBe("string");

      await page.getByRole("button", { name: "Revogar chave syntheticERP", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Revogar chave syntheticERP", exact: true })).toBeFocused();
      await page.getByRole("button", { name: "Revogar chave syntheticERP", exact: true }).click();
      const revoked = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().includes("/api/dashboard/api-keys/"));
      await page.getByRole("dialog").getByRole("button", { name: "Revogar chave", exact: true }).click();
      expect((await revoked).ok()).toBe(true);
      await expect(page.getByText("syntheticERP", { exact: true })).toBeVisible();
      const afterRevoke = await page.request.get("/api/v1/usage", { headers: { authorization: `Bearer ${secret}` } });
      expect(afterRevoke.status()).toBe(401);
    } finally {
      await restoreSyntheticFree(organizationId);
    }
});
