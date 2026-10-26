import { expect, test, type Frame, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { isolateClientIp } from "./helpers/client-ip";

test.beforeEach(async ({ context }) => { await isolateClientIp(context); });

/*
 * NEX-52: own checkout with Stripe's Payment Element, typed in the plans
 * dialog (step "3 Pagamento", never leaving /pricing) or on /checkout for
 * direct links and the "+ API" add-on. The Stripe tests need
 * UNO_LOCAL_STRIPE_E2E=1: Stripe in TEST mode (sk_test + pk_test + test price
 * ids in the app's env) and `stripe listen --forward-to
 * localhost:3100/api/stripe/webhook`, because the plan is only activated by the
 * webhook. Cards are Stripe's published test numbers; nothing real is charged.
 */
const ORIGIN = "http://127.0.0.1:3100";
const stripeE2E = process.env.UNO_LOCAL_STRIPE_E2E === "1";

async function signUp(page: Page, label: string): Promise<string> {
  const email = `uno-checkout-${label}-${crypto.randomUUID()}@example.test`;
  const data = { name: "Operador Checkout", email, password: "Checkout-e2e-password", phone: "(11) 98765-4321" };
  let signup = await page.request.post(`${ORIGIN}/api/auth/sign-up/email`, { headers: { origin: ORIGIN }, data });
  for (let attempt = 0; signup.status() === 429 && attempt < 8; attempt += 1) {
    const retryAfter = Number(signup.headers()["retry-after"]);
    await page.waitForTimeout(Math.min(30_000, Math.max(1_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 5_000)));
    signup = await page.request.post(`${ORIGIN}/api/auth/sign-up/email`, { headers: { origin: ORIGIN }, data });
  }
  expect(signup.status()).toBe(200);
  return email;
}

/** The Payment Element iframe (inside our form; Stripe's hidden controller frame is not). */
function paymentFrame(page: Page): FrameLocator {
  return page.locator('form iframe[name^="__privateStripeFrame"]').first().contentFrame();
}

async function fillCard(page: Page, number: string): Promise<void> {
  const frame = paymentFrame(page);
  const cardNumber = frame.locator('input[name="number"]');
  await expect(cardNumber).toBeVisible({ timeout: 30_000 });
  await cardNumber.fill(number);
  await frame.locator('input[name="expiry"]').fill("12/34");
  await frame.locator('input[name="cvc"]').fill("123");
  // Brazil may ask for more billing fields depending on the account; fill what appears.
  const postal = frame.locator('input[name="postalCode"]');
  if (await postal.isVisible().catch(() => false)) await postal.fill("01310-100");
  const name = frame.locator('input[name="name"]');
  if (await name.isVisible().catch(() => false)) await name.fill("Operador Checkout");
}

/** Ticks Stripe's "save for future purchases" checkbox when the element shows it. */
async function keepCard(page: Page): Promise<void> {
  const save = paymentFrame(page).locator('input[type="checkbox"]').first();
  if (await save.isVisible().catch(() => false)) await save.check();
}

/** Stripe's test 3D Secure page puts a "Complete" button inside nested iframes. */
async function completeThreeDSecure(page: Page): Promise<void> {
  await expect.poll(async () => {
    const frames: Frame[] = page.frames();
    for (const frame of frames) {
      const button = frame.getByRole("button", { name: /^(complete|concluir|autorizar)/i });
      if (await button.count().catch(() => 0)) {
        await button.first().click();
        return true;
      }
    }
    return false;
  }, { timeout: 45_000, intervals: [500, 1_000] }).toBe(true);
}

/** From /pricing, with a session: the plan's dialog, step 2, then the card step in the same dialog. */
async function openPaymentInDialog(page: Page, planName: string): Promise<Locator> {
  await page.goto("/pricing");
  await page.getByRole("link", { name: `Escolher ${planName}`, exact: true }).click();
  const summary = page.getByRole("dialog", { name: "Confirme sua assinatura" });
  await expect(summary.getByRole("radio", { name: new RegExp(planName) })).toBeChecked();
  await summary.getByRole("button", { name: /Ir para o pagamento/ }).click();
  const dialog = page.getByRole("dialog", { name: "Pagamento" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(dialog.getByTestId("pay-button")).toContainText(new RegExp(`Assinar ${planName} · R\\$`), { timeout: 30_000 });
  return dialog;
}

async function expectActivated(page: Page, title: RegExp): Promise<void> {
  // Success only appears after our server reports the plan active (webhook).
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Assinatura ativa", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/billing/, { timeout: 15_000 });
}

test.describe("checkout without Stripe", () => {
  test("shows the billing-not-configured state and fits a 375px screen", async ({ page }) => {
    test.skip(process.env.UNO_LOCAL_AUTH_E2E !== "1" || stripeE2E, "Requires local PostgreSQL and Redis, without Stripe keys");
    test.setTimeout(120_000);
    await signUp(page, "nostripe");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/checkout?plan=pro");
    await expect(page.getByRole("heading", { name: "Finalize sua assinatura" })).toBeVisible();
    await expect(page.getByText(/A cobrança ainda não está configurada/)).toBeVisible();
    await expect(page.getByTestId("pay-button")).toBeDisabled();
    await expect(page.getByTestId("pay-button")).toContainText("Assinar Pro");
    // Summary collapses on phones and opens on demand.
    // The visible label flips between "Resumo do pedido" and "Ocultar resumo".
    const toggle = page.getByRole("button", { name: /Resumo do pedido|Ocultar resumo/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("total-today").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // An invalid coupon in the URL gets the generic message.
    await page.goto("/checkout?plan=pro&coupon=NAOEXISTE");
    await expect(page.getByText("Cupom inválido ou indisponível para este plano.")).toBeVisible();
  });
});

test.describe("checkout with Stripe test mode", () => {
  test.skip(!stripeE2E, "Requires Stripe TEST keys and `stripe listen` (UNO_LOCAL_STRIPE_E2E=1)");
  test.describe.configure({ mode: "serial" });

  test("in the plans dialog, a declined card shows Stripe's message inline and a retry with another card succeeds", async ({ page }) => {
    test.setTimeout(240_000);
    await signUp(page, "decline");
    const dialog = await openPaymentInDialog(page, "Starter");
    await fillCard(page, "4000000000000002");
    await dialog.getByTestId("pay-button").click();
    await expect(dialog.getByRole("alert").filter({ hasText: /recusad|declined/i })).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByTestId("pay-button")).toBeEnabled();
    await expect(page).toHaveURL(/\/pricing$/);
    await fillCard(page, "4242424242424242");
    await dialog.getByTestId("pay-button").click();
    await expectActivated(page, /Plano Starter/);
  });

  test("a direct link to /checkout still works: an invalid coupon is refused with the generic message", async ({ page }) => {
    test.setTimeout(120_000);
    await signUp(page, "coupon");
    await page.goto("/checkout?plan=pro&coupon=NAOEXISTE");
    await expect(page.getByText("Cupom inválido ou indisponível para este plano.")).toBeVisible();
    await page.getByLabel("Cupom de desconto", { exact: true }).fill("TAMBEMNAO");
    await page.getByRole("button", { name: "Aplicar", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Cupom inválido ou indisponível para este plano." })).toBeVisible();
    await expect(page.getByTestId("pay-button")).toContainText("Assinar Pro");
  });

  test("3D Secure is completed over the plans dialog and the plan activates", async ({ page }) => {
    test.setTimeout(240_000);
    await signUp(page, "threeds");
    const dialog = await openPaymentInDialog(page, "Business");
    await fillCard(page, "4000002760003184");
    await dialog.getByTestId("pay-button").click();
    // Stripe's challenge opens over our dialog and must be reachable from it.
    await completeThreeDSecure(page);
    await expect(dialog).toBeVisible();
    await expectActivated(page, /Plano Business/);
  });

  test("4242 in the plans dialog activates the plan after the webhook, and the kept card buys + API in one click", async ({ page }) => {
    test.setTimeout(300_000);
    await signUp(page, "success");
    const dialog = await openPaymentInDialog(page, "Pro");
    await expect(dialog.getByText(/Pagamento processado pela Stripe/)).toBeVisible();
    await expect(dialog.getByTestId("total-today")).toHaveText(/15,99/);
    await fillCard(page, "4242424242424242");
    await keepCard(page);
    await dialog.getByTestId("pay-button").click();
    await expect(dialog.getByTestId("pay-button")).toBeDisabled();
    await expectActivated(page, /Plano Pro/);
    await expect(page.getByRole("heading", { name: "Pro", exact: true })).toBeVisible({ timeout: 30_000 });

    // The add-on (on /checkout): the card kept by Stripe is preselected; one click pays.
    const pay = page.getByTestId("pay-button");
    await page.goto("/checkout?addon=API");
    await expect(page.getByRole("heading", { name: "Contratar + API" })).toBeVisible();
    await expect(pay).toContainText(/Pagar com Visa •••• 4242 · R\$ 50,00\/mês|Contratar \+ API · R\$ 50,00\/mês/, { timeout: 30_000 });
    await expect(pay).toContainText("Pagar com Visa •••• 4242", { timeout: 30_000 });
    await pay.click();
    await expectActivated(page, /\+ API/);

    // The kept card is listed in Configurações → Assinatura.
    await page.goto("/dashboard/settings#assinatura");
    await expect(page.getByText("Visa •••• 4242").first()).toBeVisible({ timeout: 30_000 });
  });
});
