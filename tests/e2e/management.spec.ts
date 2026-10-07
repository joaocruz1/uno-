import { expect, test, type Browser, type Page } from "@playwright/test";

import { mailLink } from "./helpers/mail";

test.use({ trace: "off", video: "off", screenshot: "off" });

const origin = "http://127.0.0.1:3100";

async function verifiedPage(browser: Browser, label: string): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = `uno-team-e2e-${label}-${crypto.randomUUID()}@example.test`;
  let signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: { name: `Operador ${label}`, email, password: "Team-e2e-password", callbackURL: "/verify-email?verified=1" },
  });
  for (let attempt = 0; signup.status() === 429 && attempt < 8; attempt += 1) {
    const retryAfter = Number(signup.headers()["retry-after"]);
    await page.waitForTimeout(Math.min(30_000, Math.max(1_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 5_000)));
    signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
      headers: { origin },
      data: { name: `Operador ${label}`, email, password: "Team-e2e-password", callbackURL: "/verify-email?verified=1" },
    });
  }
  expect(signup.status()).toBe(200);
  await page.goto(await mailLink(page.request, email, "verify-email"));
  return { page, email };
}

test("owner renames the organization, invites a member by e-mail and the invitee joins once", async ({ browser }) => {
  test.skip(process.env.UNO_LOCAL_AUTH_E2E !== "1", "Requires local PostgreSQL, Redis and Mailpit");
  test.setTimeout(180_000);
  const owner = await verifiedPage(browser, "dona");
  const invitee = await verifiedPage(browser, "convidada");
  const organizationName = `Expedição sintética ${crypto.randomUUID().slice(0, 8)}`;

  await owner.page.goto("/dashboard/settings");
  await expect(owner.page.getByRole("heading", { name: "Configurações", exact: true })).toBeVisible();
  await owner.page.getByLabel("Nome da organização").fill(organizationName);
  await owner.page.getByRole("button", { name: "Salvar nome", exact: true }).click();
  await expect(owner.page.getByRole("main").getByText(organizationName).first()).toBeVisible();

  await owner.page.getByLabel("E-mail", { exact: true }).fill(invitee.email);
  await owner.page.getByRole("button", { name: "Enviar convite", exact: true }).click();
  await expect(owner.page.getByRole("button", { name: `Revogar convite de ${invitee.email}`, exact: true })).toBeVisible();

  const link = await mailLink(owner.page.request, invitee.email, "/invite");
  expect(link).toContain("#token=");
  await invitee.page.goto(link);
  await invitee.page.getByRole("button", { name: "Aceitar convite", exact: true }).click();
  await expect(invitee.page.getByText("Convite aceito.", { exact: false })).toBeVisible();

  // A consumed token is useless to any other identity.
  const replay = await owner.page.request.post(`${origin}/api/dashboard/invitations/accept`, {
    headers: { origin }, data: { token: new URL(link).hash.replace(/^#token=/, "") },
  });
  expect(replay.ok()).toBe(false);

  await owner.page.reload();
  await expect(owner.page.getByText(invitee.email, { exact: true }).first()).toBeVisible();
  await expect(owner.page.getByRole("button", { name: `Revogar convite de ${invitee.email}`, exact: true })).toHaveCount(0);

  await invitee.page.goto("/dashboard/settings");
  await expect(invitee.page.getByRole("main").getByText(organizationName).first()).toBeVisible();
  await owner.page.context().close();
  await invitee.page.context().close();
});

test("webhooks are plan-gated and platform administration is hidden from regular accounts", async ({ browser }) => {
  test.skip(process.env.UNO_LOCAL_AUTH_E2E !== "1", "Requires local PostgreSQL, Redis and Mailpit");
  test.setTimeout(120_000);
  const { page } = await verifiedPage(browser, "livre");
  await page.goto("/dashboard/webhooks");
  await expect(page.getByRole("heading", { name: "Webhooks", exact: true })).toBeVisible();
  await expect(page.getByText("Os webhooks estão disponíveis nos planos Pro e Business.", { exact: false })).toBeVisible();
  await expect(page.getByText("Nenhum endpoint criado", { exact: true })).toBeVisible();
  const denied = await page.request.post(`${origin}/api/dashboard/webhooks`, {
    headers: { origin }, data: { url: "https://hooks.example.com/uno", events: ["conversion.completed"] },
  });
  expect(denied.status()).toBe(403);

  expect((await page.goto("/admin"))?.status()).toBe(404);
  expect((await page.request.get(`${origin}/api/admin/overview`)).status()).toBe(403);
  await expect(page.getByRole("link", { name: "Administração", exact: true })).toHaveCount(0);
  await page.context().close();
});
