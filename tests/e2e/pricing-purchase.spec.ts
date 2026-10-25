import { expect, test } from "@playwright/test";
import { isolateClientIp } from "./helpers/client-ip";

test.beforeEach(async ({ context }) => { await isolateClientIp(context); });

/*
 * NEX-51: buying from the plans page never leaves it. Stripe is not configured
 * in e2e, so the flow is asserted up to the summary step and its "billing not
 * configured" state; a coupon that applies needs Stripe and is covered by
 * Vitest (tests/coupons.test.ts) with a fake provider.
 */
test("sign-up inside the pricing dialog requires a phone and continues to the summary on /pricing", async ({ page }, info) => {
  test.skip(process.env.UNO_LOCAL_AUTH_E2E !== "1", "Requires local PostgreSQL and Redis");
  test.setTimeout(120_000);
  const email = `uno-pricing-e2e-${info.project.name}-${crypto.randomUUID()}@example.test`;
  await page.goto("/pricing");
  await page.getByRole("link", { name: "Escolher Pro", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Crie sua conta para assinar" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Plano escolhido")).toBeVisible();
  await expect(dialog.getByText("Pro", { exact: true })).toBeVisible();

  await dialog.getByLabel("Nome", { exact: true }).fill("Operador Planos");
  await dialog.getByLabel("E-mail", { exact: true }).fill(email);
  await dialog.getByLabel("Senha", { exact: true }).fill("Pricing-e2e-password");
  await dialog.getByLabel("Confirmar senha", { exact: true }).fill("Pricing-e2e-password");
  await dialog.getByRole("button", { name: /Criar conta e continuar/ }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Informe seu telefone com DDD.");

  await dialog.getByLabel("Telefone (com DDD)", { exact: true }).fill("(10) 9876");
  await dialog.getByRole("button", { name: /Criar conta e continuar/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("Informe um telefone válido com DDD");

  await dialog.getByLabel("Telefone (com DDD)", { exact: true }).fill("11987654321");
  await expect(dialog.getByLabel("Telefone (com DDD)", { exact: true })).toHaveValue("(11) 98765-4321");
  await dialog.getByRole("button", { name: /Criar conta e continuar/ }).click();

  const summary = page.getByRole("dialog", { name: "Confirme sua assinatura" });
  await expect(summary).toBeVisible();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(summary.getByRole("radio", { name: /Pro/ })).toBeChecked();
  await expect(summary.getByText("A cobrança ainda não está configurada para esta instalação.")).toBeVisible();
  await expect(summary.getByRole("button", { name: /Ir para o pagamento/ })).toBeDisabled();

  // An invalid coupon gets a clear message and the price stays the plan's own.
  await summary.getByLabel("Cupom de desconto", { exact: true }).fill("naoexiste");
  await summary.getByRole("button", { name: "Aplicar", exact: true }).click();
  await expect(summary.getByRole("alert")).toHaveText("Cupom inválido ou indisponível para este plano.");
  await expect(summary.getByTestId("first-payment")).toHaveText(/15,99/);

  // Closing and opening again goes straight to the summary: the session is kept.
  await page.keyboard.press("Escape");
  await expect(summary).toBeHidden();
  await page.getByRole("link", { name: "Escolher Business", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Confirme sua assinatura" }).getByRole("radio", { name: /Business/ })).toBeChecked();
});

test("an existing e-mail is handled in the dialog and can sign in there", async ({ page }, info) => {
  test.skip(process.env.UNO_LOCAL_AUTH_E2E !== "1", "Requires local PostgreSQL and Redis");
  test.setTimeout(120_000);
  const origin = "http://127.0.0.1:3100";
  const email = `uno-pricing-login-${info.project.name}-${crypto.randomUUID()}@example.test`;
  const created = await page.context().request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: { name: "Conta Existente", email, password: "Pricing-e2e-password", phone: "(21) 3456-7890" },
  });
  expect(created.status()).toBe(200);
  await page.context().clearCookies();

  await page.goto("/pricing");
  await page.getByRole("link", { name: "Escolher Starter", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Crie sua conta para assinar" });
  await dialog.getByLabel("Nome", { exact: true }).fill("Outra Pessoa");
  await dialog.getByLabel("E-mail", { exact: true }).fill(email);
  await dialog.getByLabel("Telefone (com DDD)", { exact: true }).fill("11987654321");
  await dialog.getByLabel("Senha", { exact: true }).fill("Pricing-e2e-password");
  await dialog.getByLabel("Confirmar senha", { exact: true }).fill("Pricing-e2e-password");
  await dialog.getByRole("button", { name: /Criar conta e continuar/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("Já existe uma conta com este e-mail.");
  await dialog.getByRole("button", { name: "Entrar com este e-mail" }).click();
  await expect(dialog.getByRole("tab", { name: "Já tenho conta" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel("E-mail", { exact: true })).toHaveValue(email);
  await dialog.getByLabel("Senha", { exact: true }).fill("Pricing-e2e-password");
  await dialog.getByRole("button", { name: /Entrar e continuar/ }).click();
  const summary = page.getByRole("dialog", { name: "Confirme sua assinatura" });
  await expect(summary.getByRole("radio", { name: /Starter/ })).toBeChecked();
  await expect(page).toHaveURL(/\/pricing$/);
});
