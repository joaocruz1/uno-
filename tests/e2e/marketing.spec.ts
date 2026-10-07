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
