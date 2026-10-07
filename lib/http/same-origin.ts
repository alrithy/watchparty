/** True for browser requests made from another site's page. */
export function isCrossSite(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return true;
  }
}
