import { readFile, writeFile } from "node:fs/promises";

import Stripe from "stripe";

import { formatBrlCents, getApiAddon, getPlanCatalog } from "../src/lib/plans";

/**
 * Creates (idempotently) the three monthly BRL plan products/prices, the
 * "UNO API" add-on product/price and the Customer Portal configuration in the
 * Stripe account of STRIPE_SECRET_KEY, archives older active prices of those
 * products (so superseded amounts stop being purchasable), then writes the
 * four price ids into the given env file.
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
  const description = "etiquetas por mês";
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
        description: `${catalog[plan].monthlyLimit.toLocaleString("pt-BR")} ${description}`,
        metadata: { uno_plan: plan },
      }, { idempotencyKey: `uno-product-${plan}-v2` });
      // A product created under an earlier catalog may still advertise what that plan used to include.
      const planDescription = `${catalog[plan].monthlyLimit.toLocaleString("pt-BR")} ${description}`;
      if (product.description !== planDescription) await stripe.products.update(product.id, { description: planDescription });
      price = await stripe.prices.create({
        product: product.id, currency: "brl", unit_amount: amount, recurring: { interval: "month", interval_count: 1 },
        lookup_key: lookupKey, metadata: { uno_plan: plan },
      }, { idempotencyKey: `uno-price-${lookupKey}-v1` });
    }
    prices[plan] = price.id;
    products[plan] = typeof price.product === "string" ? price.product : price.product.id;
    console.info(`${plan}: ${formatBrlCents(amount)}/mês`);
  }

  // The API add-on: its own product and price, sold as a separate subscription.
  const addon = getApiAddon();
  const addonLookupKey = `uno_addon_api_monthly_brl_${addon.priceBrlCents}`;
  let addonPrice = (await stripe.prices.list({ lookup_keys: [addonLookupKey], active: true, limit: 1 })).data[0];
  if (!addonPrice) {
    const found = await stripe.products.search({ query: `metadata['uno_addon']:'API' AND active:'true'`, limit: 1 }).catch(() => ({ data: [] as Stripe.Product[] }));
    const product = found.data[0] ?? await stripe.products.create({
      name: "UNO API",
      description: "Adicional: API pública, chaves de API e webhooks",
      metadata: { uno_addon: "API" },
    }, { idempotencyKey: "uno-product-addon-API-v1" });
    addonPrice = await stripe.prices.create({
      product: product.id, currency: "brl", unit_amount: addon.priceBrlCents, recurring: { interval: "month", interval_count: 1 },
      lookup_key: addonLookupKey, metadata: { uno_addon: "API" },
    }, { idempotencyKey: `uno-price-${addonLookupKey}-v1` });
  }
  const addonProductId = typeof addonPrice.product === "string" ? addonPrice.product : addonPrice.product.id;
  console.info(`Adicional API: ${formatBrlCents(addon.priceBrlCents)}/mês`);

  // Archive every other active price of the UNO products so superseded amounts
  // can no longer be bought. Existing subscriptions on an archived price keep renewing.
  const current = new Set([...Object.values(prices), addonPrice.id]);
  let archived = 0;
  const unoProducts = new Set([...Object.values(products), addonProductId]);
  // Also cover UNO products that no longer hold a current price (search is unavailable in some accounts).
  for (const query of ["-metadata['uno_plan']:null", "-metadata['uno_addon']:null"]) {
    const found = await stripe.products.search({ query, limit: 100 }).catch(() => ({ data: [] as Stripe.Product[] }));
    for (const product of found.data) if (product.metadata.uno_plan || product.metadata.uno_addon) unoProducts.add(product.id);
  }
  for (const productId of unoProducts) {
    for await (const price of stripe.prices.list({ product: productId, active: true, limit: 100 })) {
      if (current.has(price.id)) continue;
      await stripe.prices.update(price.id, { active: false });
      archived += 1;
    }
  }
  console.info(`Preços antigos arquivados: ${archived}.`);

  const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
    customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    // Only the three plan products: the add-on is a separate subscription and is never a plan switch target.
    subscription_update: {
      enabled: true, default_allowed_updates: ["price"], proration_behavior: "create_prorations",
      products: Object.keys(prices).map((plan) => ({ product: products[plan]!, prices: [prices[plan]!] })),
    },
  };
  const business_profile = { headline: "UNO — Duas páginas. Uma etiqueta." };
  const portal = (await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 })).data[0];
  if (portal) await stripe.billingPortal.configurations.update(portal.id, { features, business_profile });
  else await stripe.billingPortal.configurations.create({ features, business_profile, default_return_url: returnUrl });
  console.info("Portal do cliente configurado.");

  const set = (name: string, value: string) => {
    const line = `${name}=${value}`;
    env = new RegExp(`^${name}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${name}=.*$`, "m"), line) : `${env.trimEnd()}\n${line}\n`;
  };
  for (const plan of Object.keys(prices)) set(`STRIPE_PRICE_${plan}`, prices[plan]!);
  set("STRIPE_PRICE_API_ADDON", addonPrice.id);
  await writeFile(envPath, env);
  console.info(`IDs de preço gravados em ${envPath}.`);
}

main().catch((error: unknown) => {
  console.error("Não foi possível configurar a Stripe:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
