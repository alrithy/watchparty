export type ClockSample = {
  /** Local time the request was sent. */
  sentAt: number;
  /** Local time the response arrived. */
  receivedAt: number;
  /** Server time reported in the response. */
  serverTime: number;
};

/**
 * NTP-style offset estimate: pick the sample with the smallest round trip
 * (least queuing noise) and assume the server stamped it halfway through.
 * Returns serverTime - localTime in ms.
 */
export function estimateOffset(samples: ClockSample[]): { offset: number; rtt: number } {
  if (samples.length === 0) return { offset: 0, rtt: Infinity };
  let best = samples[0];
  for (const s of samples) {
    if (s.receivedAt - s.sentAt < best.receivedAt - best.sentAt) best = s;
  }
  const rtt = best.receivedAt - best.sentAt;
  return { offset: best.serverTime + rtt / 2 - best.receivedAt, rtt };
}

/** Shared reference clock: every client converts to server time before comparing. */
export class ServerClock {
  private offset = 0;
  rtt = Infinity;
  synced = false;

  constructor(private endpoint = "/api/time") {}

  now(): number {
    return Date.now() + this.offset;
  }

  async sync(sampleCount = 5): Promise<void> {
    const samples: ClockSample[] = [];
    for (let i = 0; i < sampleCount; i++) {
      try {
        const sentAt = Date.now();
        const res = await fetch(this.endpoint, { cache: "no-store" });
        const receivedAt = Date.now();
        const { now } = (await res.json()) as { now: number };
        samples.push({ sentAt, receivedAt, serverTime: now });
      } catch {
        // A failed sample is just skipped.
      }
    }
    if (samples.length === 0) return;
    const { offset, rtt } = estimateOffset(samples);
    this.offset = offset;
    this.rtt = rtt;
    this.synced = true;
  }
}
