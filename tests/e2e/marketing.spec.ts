import { expect, test } from "@playwright/test";
test("landing identifies UNO and stays within the viewport", async ({page})=>{
  await page.goto("/");
  await expect(page).toHaveTitle(/UNO/);
  await expect(page.locator("html")).toHaveAttribute("lang","pt-BR");
  await expect(page.getByRole("heading",{level:1})).toContainText(/DUAS PÁGINAS/i);
  const hasOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
  expect(hasOverflow).toBe(false);
  await expect(page.getByRole("link",{name:/unir minha etiqueta/i}).first()).toHaveAttribute("href",/register/);
});
test("pricing and documentation expose the real commercial and API contract",async({page})=>{
  await page.goto("/pricing");
  await expect(page.getByRole("heading",{level:1})).toBeVisible();
  await expect(page.getByText(/2.000/).first()).toBeVisible();
  await page.goto("/docs");
  await expect(page.getByRole("heading",{level:1})).toBeVisible();
  await expect(page.locator("main")).toContainText("/api/v1/conversions");
  await expect(page.locator("main")).toContainText("Idempotency-Key");
});
test("reduced motion hydrates without browser errors", async ({page})=>{
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto("/",{waitUntil:"networkidle"});
  await expect(page.getByText("Etiqueta pronta",{exact:true}).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("landing converts one label without an account and then asks for sign-up", async ({page})=>{
  test.skip(process.env.UNO_LOCAL_UPLOAD_E2E !== "1", "Requires the local app with Redis");
  test.setTimeout(90_000);
  const { syntheticPdf } = await import("../fixtures/synthetic-pdf");
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${Math.floor(Math.random()*250)+1}` });
  await page.goto("/");
  await expect(page.getByRole("heading",{name:"Jogue sua etiqueta aqui.",exact:true})).toBeVisible();
  await page.getByLabel("Selecionar PDF para o teste gratuito").setInputFiles({ name:"synthetic.pdf", mimeType:"application/pdf", buffer:Buffer.from(await syntheticPdf({ fiscalSummary:true })) });
  await expect(page.getByText("Etiqueta unificada",{exact:true})).toBeVisible({ timeout:45_000 });
  await expect(page.getByRole("img",{name:"Etiqueta unificada, página 1",exact:true})).toHaveCount(1,{ timeout:20_000 });
  const download = page.waitForEvent("download");
  await page.getByRole("link",{name:"Baixar etiqueta",exact:true}).click();
  expect((await download).suggestedFilename()).toBe("uno-etiqueta-unificada.pdf");
  await page.reload();
  await expect(page.getByRole("heading",{name:"Você já usou o teste gratuito.",exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:/Criar conta grátis/})).toHaveAttribute("href","/register");
});
