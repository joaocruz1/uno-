import { expect, test } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { mailLink } from "./helpers/mail";

test("private dashboard upload validates and uploads a synthetic PDF", async ({ page }) => {
  test.skip(process.env.UNO_LOCAL_UPLOAD_E2E !== "1", "Requires local PostgreSQL, Redis, S3 and Mailpit");
  const origin = "http://127.0.0.1:3100";
  const email = `uno-upload-e2e-${crypto.randomUUID()}@example.test`;
  const signup = await page.request.post(`${origin}/api/auth/sign-up/email`, { headers: { origin }, data: { name: "Operador Upload", email, password: "Synthetic-upload-password", callbackURL: "/verify-email?verified=1" } });
  expect(signup.status()).toBe(200);
  await page.goto(await mailLink(page.request, email, "verify-email"));
  await page.goto("/dashboard/process");
  await expect(page.getByRole("button", { name: "Selecionar arquivo", exact: true })).toBeVisible();
  const file = page.getByLabel("Selecionar arquivo PDF", { exact: true });
  await file.setInputFiles({ name: "invalid.pdf", mimeType: "application/pdf", buffer: Buffer.from("invalid") });
  await expect(page.getByRole("alert").filter({ hasText: /assinatura PDF/ })).toBeVisible();
  await page.getByRole("button", { name: "Escolher outro arquivo" }).click();
  const doc = await PDFDocument.create();
  doc.addPage([283.4646, 425.1969]); doc.addPage([283.4646, 425.1969]);
  await file.setInputFiles({ name: "synthetic.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) });
  await expect(page.getByText("Arquivo enviado", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("synthetic.pdf", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
