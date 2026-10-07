import { readFile, writeFile } from "node:fs/promises";

import Stripe from "stripe";

import { getPlanCatalog } from "../src/lib/plans";

/**
 * Creates (idempotently) the three monthly BRL products/prices and the
 * Customer Portal configuration in the Stripe account of STRIPE_SECRET_KEY,
 * then writes the price ids into the given env file.
 *
 *   pnpm stripe:setup .env.local        # test mode
 *   pnpm stripe:setup .env.production   # live mode, with your sk_live key in that file
 *
 * The key is read from the env file and never printed.
 */
async function main(): Promise<void> {
  const envPath = process.argv[2];
  if (!envPath) throw new Error("Informe o arquivo de ambiente, por exemplo: pnpm stripe:setup .env.production");
  let env = await readFile(envPath, "utf8");
  const read = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(env)?.[1]?.trim() ?? "";
  const key = read("STRIPE_SECRET_KEY");
  if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(key)) throw new Error(`Preencha STRIPE_SECRET_KEY em ${envPath} antes de rodar.`);
  const returnUrl = `${(read("APP_URL") || "http://127.0.0.1:3100").replace(/\/$/, "")}/dashboard/billing`;
  const stripe = new Stripe(key);
  const livemode = (await stripe.balance.retrieve()).livemode;
  console.info(`Conta Stripe autenticada em modo ${livemode ? "REAL (live)" : "de teste"}.`);

  const catalog = getPlanCatalog();
  const descriptions = { STARTER: "etiquetas por mês", PRO: "etiquetas por mês, API e webhooks", BUSINESS: "etiquetas por mês, API e webhooks" } as const;
  const prices: Record<string, string> = {};
  const products: Record<string, string> = {};
  for (const plan of ["STARTER", "PRO", "BUSINESS"] as const) {
    const amount = catalog[plan].priceBrlCents;
    const lookupKey = `uno_${plan.toLowerCase()}_monthly_brl_${amount}`;
    let price = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })).data[0];
    if (!price) {
      const found = await stripe.products.search({ query: `metadata['uno_plan']:'${plan}' AND active:'true'`, limit: 1 }).catch(() => ({ data: [] as Stripe.Product[] }));
      const product = found.data[0] ?? await stripe.products.create({
        name: `UNO ${catalog[plan].name}`,
        description: `${catalog[plan].monthlyLimit.toLocaleString("pt-BR")} ${descriptions[plan]}`,
        metadata: { uno_plan: plan },
      }, { idempotencyKey: `uno-product-${plan}-v1` });
      price = await stripe.prices.create({
        product: product.id, currency: "brl", unit_amount: amount, recurring: { interval: "month", interval_count: 1 },
        lookup_key: lookupKey, metadata: { uno_plan: plan },
      }, { idempotencyKey: `uno-price-${lookupKey}-v1` });
    }
    prices[plan] = price.id;
    products[plan] = typeof price.product === "string" ? price.product : price.product.id;
    console.info(`${plan}: R$ ${(amount / 100).toFixed(2).replace(".", ",")}/mês`);
  }

  const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
    customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    subscription_update: {
      enabled: true, default_allowed_updates: ["price"], proration_behavior: "create_prorations",
      products: Object.keys(prices).map((plan) => ({ product: products[plan]!, prices: [prices[plan]!] })),
    },
  };
  const business_profile = { headline: "UNO — Duas páginas. Uma etiqueta." };
  const current = (await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 })).data[0];
  if (current) await stripe.billingPortal.configurations.update(current.id, { features, business_profile });
  else await stripe.billingPortal.configurations.create({ features, business_profile, default_return_url: returnUrl });
  console.info("Portal do cliente configurado.");

  const set = (name: string, value: string) => {
    const line = `${name}=${value}`;
    env = new RegExp(`^${name}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${name}=.*$`, "m"), line) : `${env.trimEnd()}\n${line}\n`;
  };
  for (const plan of Object.keys(prices)) set(`STRIPE_PRICE_${plan}`, prices[plan]!);
  await writeFile(envPath, env);
  console.info(`IDs de preço gravados em ${envPath}.`);
}

main().catch((error: unknown) => {
  console.error("Não foi possível configurar a Stripe:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
