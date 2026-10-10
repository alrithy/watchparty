/**
 * Per-client sliding-window limit and a per-instance concurrency cap for the
 * endpoints that make server-side requests to pasted URLs.
 *
 * In memory only: on Vercel each function instance keeps its own counts, so
 * this stops a single browser hammering the endpoint, not a distributed abuser.
 * Production should add a Vercel WAF rate-limit rule on /api/media/* (see
 * docs/PLAYBACK_SECURITY_REVIEW.md).
 */

type Window = { hits: number[] };

export class RateLimiter {
  private readonly clients = new Map<string, Window>();
  private inFlight = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxConcurrent: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes a slot for `key`, or says why not. Call the returned release when the work ends. */
  acquire(key: string): { ok: true; release: () => void } | { ok: false; reason: "rate" | "busy" } {
    const t = this.now();
    const w = this.clients.get(key) ?? { hits: [] };
    w.hits = w.hits.filter((h) => t - h < this.windowMs);
    if (w.hits.length >= this.limit) {
      this.clients.set(key, w);
      return { ok: false, reason: "rate" };
    }
    if (this.inFlight >= this.maxConcurrent) return { ok: false, reason: "busy" };
    w.hits.push(t);
    this.clients.set(key, w);
    if (this.clients.size > 5000) this.prune(t);
    this.inFlight++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight--;
      },
    };
  }

  private prune(t: number) {
    for (const [k, w] of this.clients) if (!w.hits.some((h) => t - h < this.windowMs)) this.clients.delete(k);
  }
}

/** The client's address as Vercel reports it (first x-forwarded-for entry), for rate-limit keys only. */
export function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || request.headers.get("x-real-ip") || "unknown";
}
