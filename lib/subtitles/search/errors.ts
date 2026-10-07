import type { ProviderId } from "@/lib/subtitles/search/score";

/** A provider failure with a message safe to show (never a URL or key). */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    message: string,
  ) {
    super(message);
  }
}
