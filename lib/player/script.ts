const pending = new Map<string, Promise<void>>();

/** Loads a provider's official script once per page. */
export function loadScript(src: string, isReady: () => boolean, waitForReady?: (done: () => void) => void): Promise<void> {
  if (isReady()) return Promise.resolve();
  const existing = pending.get(src);
  if (existing) return existing;
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onerror = () => {
      pending.delete(src);
      reject(new Error(`Couldn't load ${new URL(src).hostname}`));
    };
    if (waitForReady) waitForReady(resolve);
    else el.onload = () => resolve();
    document.head.appendChild(el);
  });
  pending.set(src, p);
  return p;
}

/**
 * Smooths a provider's coarse position reports (iframes post them a few times
 * a second) by extrapolating from the last change while playing.
 */
export class PositionClock {
  private value = 0;
  private at = performance.now();
  /** Record a reported position. While paused the anchor time stays fresh, so resuming doesn't jump ahead. */
  set(seconds: number, playing: boolean) {
    if (seconds !== this.value || !playing) {
      this.value = seconds;
      this.at = performance.now();
    }
  }
  reset(seconds: number) {
    this.value = seconds;
    this.at = performance.now();
  }
  get(playing: boolean, rate = 1): number {
    if (!playing) return this.value;
    const elapsed = Math.min(1, (performance.now() - this.at) / 1000);
    return this.value + elapsed * rate;
  }
}
