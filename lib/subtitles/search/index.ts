import "server-only";
import { ProviderError } from "@/lib/subtitles/search/errors";
import { downloadOpenSubtitles, openSubtitlesConfigured, searchOpenSubtitles } from "@/lib/subtitles/search/opensubtitles";
import { parseRelease } from "@/lib/subtitles/search/release";
import { autoPick, rankCandidates, type Candidate, type ProviderId, type Ranked, type Wanted } from "@/lib/subtitles/search/score";
import { downloadSubdl, searchSubdl, subdlConfigured } from "@/lib/subtitles/search/subdl";

export const MAX_RESULTS = 8;

type Provider = {
  configured: () => boolean;
  search: (w: Wanted) => Promise<Candidate[]>;
  download: (id: string, maxBytes: number) => Promise<ArrayBuffer>;
};

/** OpenSubtitles first; SubDL adds Arabic coverage. */
const PROVIDERS: Record<ProviderId, Provider> = {
  opensubtitles: { configured: openSubtitlesConfigured, search: searchOpenSubtitles, download: downloadOpenSubtitles },
  subdl: { configured: subdlConfigured, search: searchSubdl, download: downloadSubdl },
};

export function isProvider(id: unknown): id is ProviderId {
  return typeof id === "string" && Object.hasOwn(PROVIDERS, id);
}

export function anyProviderConfigured(): boolean {
  return Object.values(PROVIDERS).some((p) => p.configured());
}

export type SearchResult = {
  wanted: Pick<Wanted, "title" | "year" | "season" | "episode" | "releaseGroup" | "source" | "resolution">;
  results: Ranked[];
  /** True when results[0] is confident enough to apply without asking. */
  autoSelect: boolean;
  errors: { provider: ProviderId; message: string }[];
};

/** Builds what we're looking for from the video's file name or page title, or what the host typed. */
export function wantedFrom(opts: { name: string | null; fileName: string | null; imdbId: string | null; language?: string }): Wanted {
  const info = parseRelease(opts.name ?? "");
  return {
    ...info,
    fileName: opts.fileName,
    imdbId: opts.imdbId,
    language: opts.language ?? "ar",
    hearingImpaired: false,
    fps: null,
  };
}

export async function findSubtitles(wanted: Wanted): Promise<SearchResult> {
  const active = (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => PROVIDERS[id].configured());
  const settled = await Promise.allSettled(active.map((id) => PROVIDERS[id].search(wanted)));
  const candidates: Candidate[] = [];
  const errors: SearchResult["errors"] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") candidates.push(...s.value);
    else errors.push({ provider: active[i], message: s.reason instanceof ProviderError ? s.reason.message : "Search failed." });
  });
  const results = rankCandidates(wanted, candidates).slice(0, MAX_RESULTS);
  return {
    wanted: {
      title: wanted.title,
      year: wanted.year,
      season: wanted.season,
      episode: wanted.episode,
      releaseGroup: wanted.releaseGroup,
      source: wanted.source,
      resolution: wanted.resolution,
    },
    results,
    autoSelect: autoPick(results) !== null,
    errors,
  };
}

export function downloadSubtitle(provider: ProviderId, id: string, maxBytes: number): Promise<ArrayBuffer> {
  return PROVIDERS[provider].download(id, maxBytes);
}
