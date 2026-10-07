import { expect, test, type Page } from "@playwright/test";

import { mailLink } from "./helpers/mail";

async function verifiedPage(page: Page): Promise<void> {
  const origin = "http://127.0.0.1:3100";
  const email = `uno-billing-e2e-${crypto.randomUUID()}@example.test`;
  let signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: { name: "Operador Cobrança", email, password: "Billing-e2e-password", callbackURL: "/verify-email?verified=1" },
  });
  for (let attempt = 0; signup.status() === 429 && attempt < 8; attempt += 1) {
    const retryAfter = Number(signup.headers()["retry-after"]);
    await page.waitForTimeout(Math.min(30_000, Math.max(1_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 5_000)));
    signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
      headers: { origin },
      data: { name: "Operador Cobrança", email, password: "Billing-e2e-password", callbackURL: "/verify-email?verified=1" },
    });
  }
  expect(signup.status()).toBe(200);
  await page.goto(await mailLink(page.request, email, "verify-email"));
}

test("free billing state is explicit when Stripe is unavailable", async ({ page }) => {
  test.skip(process.env.UNO_LOCAL_AUTH_E2E !== "1", "Requires local PostgreSQL and Mailpit");
  test.setTimeout(120_000);
  await verifiedPage(page);
  await page.goto("/dashboard/billing");
  await expect(page.getByRole("heading", { name: "Assinatura", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Free", exact: true })).toBeVisible();
  await expect(page.getByText("A cobrança ainda não está configurada para esta instalação.", { exact: true })).toBeVisible();
  const paidPlanActions = page.getByRole("button", { name: /Escolher|Alterar no portal/ });
  await expect(paidPlanActions).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) await expect(paidPlanActions.nth(index)).toBeDisabled();
});

test("usage shows the free 0/10 state and mobile dashboard links", async ({ page }) => {
  test.skip(process.env.UNO_LOCAL_AUTH_E2E !== "1", "Requires local PostgreSQL and Mailpit");
  test.setTimeout(120_000);
  await verifiedPage(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard/usage");
  await expect(page.getByRole("heading", { name: "Uso", exact: true })).toBeVisible();
  await expect(page.getByText("Concluídas", { exact: true }).locator("..")).toContainText("0");
  await expect(page.getByText("Reservadas", { exact: true }).locator("..")).toContainText("0");
  await expect(page.getByText("Disponíveis", { exact: true }).locator("..")).toContainText("10");
  await page.getByText("Menu", { exact: true }).click();
  const mobileNav = page.getByRole("navigation", { name: "Dashboard móvel", exact: true });
  await expect(mobileNav).toBeVisible();
  await expect(mobileNav.getByRole("link", { name: "Uso", exact: true })).toHaveAttribute("href", "/dashboard/usage");
  await expect(mobileNav.getByRole("link", { name: "Assinatura", exact: true })).toHaveAttribute("href", "/dashboard/billing");
});
