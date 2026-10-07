import { expect, test } from "@playwright/test";

import { mailLink } from "./helpers/mail";
import { syntheticPdf } from "../fixtures/synthetic-pdf";

test("history searches a failed conversion and reprocesses it with an independent quota event", async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(process.env.UNO_LOCAL_UPLOAD_E2E !== "1", "Requires local PostgreSQL, Redis, S3, Mailpit and worker");

  const origin = "http://127.0.0.1:3100";
  const email = `uno-history-e2e-${crypto.randomUUID()}@example.test`;
  const signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: { name: "Operador Histórico", email, password: "Synthetic-history-password", callbackURL: "/verify-email?verified=1" },
  });
  expect(signup.status()).toBe(200);
  await page.goto(await mailLink(page.request, email, "verify-email"));

  const buffer = Buffer.from(await syntheticPdf());
  await page.goto("/dashboard/process");
  await page.getByLabel("Selecionar arquivo PDF", { exact: true }).setInputFiles({ name: "history-synthetic.pdf", mimeType: "application/pdf", buffer });
  await expect(page.getByText("Não foi possível unificar este PDF", { exact: true })).toBeVisible({ timeout: 45_000 });

  await page.goto("/dashboard/history");
  await page.getByLabel("Buscar por arquivo", { exact: true }).fill("history-synthetic.pdf");
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(page.getByText("history-synthetic.pdf", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Ver detalhes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "history-synthetic.pdf", exact: true })).toBeVisible();

  await expect(page.getByLabel("Largura (mm)", { exact: true })).toHaveValue("100");
  await expect(page.getByLabel("Altura (mm)", { exact: true })).toHaveValue("150");
  await page.getByLabel("Altura (mm)", { exact: true }).fill("250");
  await page.getByRole("button", { name: "Reprocessar", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/history\/[0-9a-f-]+$/);
  await expect(page.getByText("Duas páginas. Uma etiqueta.", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("img", { name: "Depois, página 1", exact: true })).toHaveCount(1, { timeout: 20_000 });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Baixar PDF", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^uno-[0-9a-f-]+\.pdf$/);

  await page.goto("/dashboard");
  await expect(page.getByText("Uso do período", { exact: true }).locator("..")).toContainText("1");
});
