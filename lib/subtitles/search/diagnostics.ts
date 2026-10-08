import type { ProviderId } from "@/lib/subtitles/search/score";

/**
 * What one provider query returned, for telling apart a provider error, an empty
 * search, subtitles we couldn't use and subtitles the ranking dropped. Counts and
 * short error codes only: never a URL, key or file name.
 */
export type QueryDiagnostics = {
  provider: ProviderId;
  query: string;
  httpStatus: number | null;
  /** The provider's own success flag, when it sends one. */
  providerStatus: boolean | null;
  error: string | null;
  /** Titles the provider matched. */
  results: number;
  /** Subtitles it listed. */
  subtitles: number;
  /** Candidates we kept from them. */
  accepted: number;
  /** Why the others were dropped, with counts. */
  rejected: Record<string, number>;
  /** diagnose mode only: the field names and identity fields of the first few subtitles. */
  sample?: unknown[];
};
