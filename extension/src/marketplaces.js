// Domains of the marketplace seller centers. A download counts as coming from a
// marketplace when its URL, its referrer or the blob's origin is on one of them.
export const MARKETPLACES = {
  "mercado-livre": {
    label: "Mercado Livre",
    hosts: ["mercadolivre.com.br", "mercadolibre.com", "mercadolibre.com.br", "mercadoshops.com.br"],
  },
  shopee: {
    label: "Shopee",
    hosts: ["shopee.com.br", "shopee.com", "susercontent.com"],
  },
  tiktok: {
    label: "TikTok Shop",
    hosts: ["tiktok.com", "tiktokshop.com", "tiktokglobalshop.com", "tiktokcdn.com", "ibytedtos.com"],
  },
};

export const MARKETPLACE_IDS = Object.keys(MARKETPLACES);

function hostOf(value) {
  if (!value) return "";
  try {
    const url = new URL(value.startsWith("blob:") ? value.slice(5) : value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

/** Returns the marketplace id for the first candidate URL on a known domain. */
export function marketplaceFor(...candidates) {
  for (const candidate of candidates) {
    const host = hostOf(candidate);
    if (!host) continue;
    for (const [id, marketplace] of Object.entries(MARKETPLACES)) {
      if (marketplace.hosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) return id;
    }
  }
  return null;
}
