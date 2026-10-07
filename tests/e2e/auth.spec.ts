import { expect, test, type APIRequestContext } from "@playwright/test";

type Mail = { ID: string; To: Array<{ Address: string }> };
async function mailLink(request: APIRequestContext, email: string, kind: string) {
  let link = "";
  await expect.poll(async () => {
    const inbox = await (await request.get("http://127.0.0.1:8025/api/v1/messages")).json() as { messages: Mail[] };
    for (const message of inbox.messages.filter(item => item.To.some(to => to.Address === email))) {
      const body = await (await request.get(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)).json() as { Text: string };
      const candidate = body.Text.match(/http[^\s]+/g)?.find(url => url.includes(kind));
      if (candidate) { link = candidate; return true; }
    }
    return false;
  }, { timeout: 20_000, message: "O e-mail de teste deve chegar ao SMTP local" }).toBe(true);
  return link;
}

test("verified registration, session, logout and password recovery", async ({ page, request }, info) => {
  test.skip(process.env.UNO_LOCAL_AUTH_E2E !== "1", "Requires local PostgreSQL, Redis and Mailpit");
  test.setTimeout(120_000);
  const email = `uno-e2e-${info.project.name}-${crypto.randomUUID()}@example.test`;
  const password = "Uno-test-password-2026";
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/register");
  await page.getByLabel("Nome", { exact: true }).fill("Operador Teste");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByLabel("Confirmar senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page).toHaveURL(/\/verify-email/);
  await page.goto(await mailLink(request, email, "verify-email"));
  await expect(page.getByText("E-mail confirmado. Sua conta está pronta.")).toBeVisible();
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Olá, Operador" })).toBeVisible();
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/forgot-password");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  const resetResponsePromise = page.waitForResponse(response => response.url().endsWith("/api/auth/request-password-reset"));
  await page.getByRole("button", { name: "Enviar instruções" }).click();
  const resetResponse = await resetResponsePromise;
  if (resetResponse.status() === 429) {
    // The browser projects share localhost's IP. Preserve the production guard
    // and honor its real retry window rather than disabling it for this suite.
    const seconds = Number(resetResponse.headers()["retry-after"] ?? "60");
    await new Promise(resolve => setTimeout(resolve, Math.min(61, seconds + 1) * 1000));
    await page.getByRole("button", { name: "Enviar instruções" }).click();
  } else expect(resetResponse.status()).toBe(200);
  await expect(page.getByText(/você receberá as instruções/)).toBeVisible();
  await page.goto(await mailLink(request, email, "reset-password"));
  await page.getByLabel("Nova senha", { exact: true }).fill(`${password}-new`);
  await page.getByLabel("Confirmar nova senha", { exact: true }).fill(`${password}-new`);
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(`${password}-new`);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});
