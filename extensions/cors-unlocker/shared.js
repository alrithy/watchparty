// Settings shared by the service worker and the options page.

/** Where WatchParty runs. Only requests made by these pages get CORS headers added. */
export const APP_DOMAINS = ["vercel.app", "localhost", "127.0.0.1"];

/** Video servers to unlock by default (subdomains included). Editable on the options page. */
export const DEFAULT_CDN_DOMAINS = [
  "real-debrid.com",
  "rdeb.io",
  "alldebrid.com",
  "debrid.it",
  "premiumize.me",
  "torbox.app",
  "debrid-link.com",
];

export async function cdnDomains() {
  const { cdnDomains } = await chrome.storage.local.get("cdnDomains");
  return Array.isArray(cdnDomains) && cdnDomains.length ? cdnDomains : DEFAULT_CDN_DOMAINS;
}

/** "https://a.b.example/x" or "*.b.example" → "b.example"-style bare domain, or null. */
export function cleanDomain(input) {
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  try {
    if (s.includes("://")) s = new URL(s).hostname;
  } catch {
    return null;
  }
  s = s.replace(/^\*\./, "").replace(/\/.*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}
