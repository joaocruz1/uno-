import { expect, test, type Page } from "@playwright/test";

import { mailLink } from "./helpers/mail";
import { syntheticPdf } from "../fixtures/synthetic-pdf";

async function verifiedPage(page: Page): Promise<void> {
  const origin = "http://127.0.0.1:3100";
  const email = `uno-batch-e2e-${crypto.randomUUID()}@example.test`;
  let signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: { name: "Operador Lotes", email, password: "Synthetic-batch-password", callbackURL: "/verify-email?verified=1" },
  });
  for (let attempt = 0; signup.status() === 429 && attempt < 4; attempt += 1) {
    const retryAfter = Number(signup.headers()["retry-after"]);
    await page.waitForTimeout(Math.min(30_000, Math.max(1_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 5_000)));
    signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
      headers: { origin },
      data: { name: "Operador Lotes", email, password: "Synthetic-batch-password", callbackURL: "/verify-email?verified=1" },
    });
  }
  expect(signup.status()).toBe(200);
  await page.goto(await mailLink(page.request, email, "verify-email"));
}

test("prepares one valid batch, confirms it through the dialog, and downloads its ZIP", async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(process.env.UNO_LOCAL_UPLOAD_E2E !== "1", "Requires local PostgreSQL, Redis, S3, Mailpit and worker");
  await verifiedPage(page);
  await page.goto("/dashboard/batches");
  const buffer = Buffer.from(await syntheticPdf());
  await page.getByLabel("Altura (mm)", { exact: true }).fill("250");
  await page.getByLabel("Selecionar PDFs do lote", { exact: true }).setInputFiles({ name: "batch-valid.pdf", mimeType: "application/pdf", buffer });
  await page.getByRole("button", { name: "Preparar arquivos", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirmar lote", exact: true })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Confirmar lote", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("1 etiquetas serão reservadas");
  const closeButton = page.getByRole("button", { name: "Fechar janela", exact: true });
  await closeButton.focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirmar lote", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Confirmar lote", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Processar lote", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/batches\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Lote de 1 etiquetas", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Baixar ZIP", exact: true })).toBeVisible({ timeout: 60_000 });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Baixar ZIP", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^uno-lote-[0-9a-f-]+\.zip$/);
});

test("failed batch produces no ZIP output and releases its reservation", async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(process.env.UNO_LOCAL_UPLOAD_E2E !== "1", "Requires local PostgreSQL, Redis, S3, Mailpit and worker");
  await verifiedPage(page);
  await page.goto("/dashboard/batches");
  const buffer = Buffer.from(await syntheticPdf());
  await page.getByLabel("Selecionar PDFs do lote", { exact: true }).setInputFiles({ name: "batch-failed.pdf", mimeType: "application/pdf", buffer });
  await page.getByRole("button", { name: "Preparar arquivos", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirmar lote", exact: true })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Confirmar lote", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Processar lote", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/batches\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Falhou", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Baixar ZIP", exact: true })).toHaveCount(0);
  await expect(page.getByText("0 aprovadas", { exact: true })).toBeVisible();
  await page.goto("/dashboard");
  await expect(page.getByText("Uso do período", { exact: true }).locator("..")).toContainText("0");
});
