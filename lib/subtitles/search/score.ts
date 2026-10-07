/*
 * Subtitle ranking. The match weights, the "identity id implies title/year"
 * equivalences and the equivalent release groups are adapted from subliminal
 * (src/subliminal/score.py and matches.py), MIT License,
 * Copyright (c) 2016 Antoine Bertin. https://github.com/Diaoul/subliminal
 *
 * The penalties (wrong year, hearing impaired, machine translated, other
 * language) and the popularity tie-break are ours.
 */
import { normalizeTitle, parseRelease, stripExtension, type ReleaseInfo } from "@/lib/subtitles/search/release";

export type ProviderId = "opensubtitles" | "subdl";

/** One subtitle a provider offered, in provider-neutral form. */
export type Candidate = {
  provider: ProviderId;
  /** Opaque handle the provider's download step understands. */
  id: string;
  /** Release / file name the subtitle was made for. */
  release: string;
  /** ISO 639-1, lowercase. */
  language: string;
  hearingImpaired: boolean;
  machineTranslated: boolean;
  downloads: number;
  /** 0-10, when the provider rates subtitles. */
  rating: number | null;
  /** Uploader marked trusted by the provider. */
  trusted: boolean;
  fps: number | null;
  /** What the provider says the subtitle belongs to. */
  feature: {
    imdbId: string | null;
    title: string | null;
    year: number | null;
    season: number | null;
    episode: number | null;
  };
};

/** The video we want subtitles for. */
export type Wanted = ReleaseInfo & {
  /** File name of the video, when the URL has one. */
  fileName: string | null;
  imdbId: string | null;
  language: string;
  hearingImpaired: boolean;
  fps: number | null;
};

export type Ranked = Candidate & {
  score: number;
  /** score as a share of the best possible score, 0-100. */
  percent: number;
  confidence: "high" | "low";
  reasons: string[];
};

type Match =
  | "hash"
  | "title"
  | "series"
  | "year"
  | "season"
  | "episode"
  | "release_group"
  | "streaming_service"
  | "fps"
  | "source"
  | "audio_codec"
  | "resolution"
  | "video_codec";

/** subliminal's episode_scores ("country" dropped: release names never carry it). */
const EPISODE_SCORES: Partial<Record<Match, number>> = {
  hash: 971,
  series: 486,
  year: 162,
  episode: 54,
  season: 54,
  release_group: 18,
  streaming_service: 18,
  fps: 9,
  source: 4,
  audio_codec: 2,
  resolution: 1,
  video_codec: 1,
};

/** subliminal's movie_scores. */
const MOVIE_SCORES: Partial<Record<Match, number>> = {
  hash: 323,
  title: 162,
  year: 54,
  release_group: 18,
  streaming_service: 18,
  fps: 9,
  source: 4,
  audio_codec: 2,
  resolution: 1,
  video_codec: 1,
};

/** subliminal's equivalent_release_groups. */
const EQUIVALENT_GROUPS = [new Set(["LOL", "DIMENSION"]), new Set(["ASAP", "IMMERSE", "FLEET"]), new Set(["AVS", "SVA"])];

function groupsOf(group: string): Set<string> {
  const g = group.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return EQUIVALENT_GROUPS.find((s) => s.has(g)) ?? new Set([g]);
}

function fpsMatches(a: number | null, b: number | null): boolean {
  return a != null && b != null && a > 0 && b > 0 && Math.abs(a - b) / a < 0.0011;
}

function normalizeRelease(name: string): string {
  return normalizeTitle(stripExtension(name));
}

function episodeLabel(season: number | null, episode: number | null): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${season != null ? `S${pad(season)}` : ""}${episode != null ? `E${pad(episode)}` : ""}`;
}

/** Ranks candidates best first. Candidates for a different season/episode are dropped. */
export function rankCandidates(wanted: Wanted, candidates: Candidate[]): Ranked[] {
  const ranked: Ranked[] = [];
  for (const c of candidates) {
    const r = scoreCandidate(wanted, c);
    if (r) ranked.push(r);
  }
  return ranked.sort((a, b) => b.score - a.score);
}

export function scoreCandidate(wanted: Wanted, c: Candidate): Ranked | null {
  const isEpisode = wanted.season != null || wanted.episode != null;
  const scores = isEpisode ? EPISODE_SCORES : MOVIE_SCORES;
  const max = scores.hash!;
  const rel = parseRelease(c.release);
  const matches = new Set<Match>();
  const reasons: string[] = [];
  let penalty = 0;

  // Identity: what the subtitle belongs to, from the provider first, then its release name.
  const season = c.feature.season ?? rel.season;
  const episode = c.feature.episode ?? rel.episode;
  if (isEpisode) {
    if (wanted.season != null && season != null && season !== wanted.season) return null;
    if (wanted.episode != null && episode != null && episode !== wanted.episode) return null;
    if (wanted.season != null && season === wanted.season) matches.add("season");
    if (wanted.episode != null && episode === wanted.episode) matches.add("episode");
  }
  const wantTitle = normalizeTitle(wanted.title);
  const titles = [c.feature.title, rel.title].map(normalizeTitle).filter(Boolean);
  if (wantTitle && titles.includes(wantTitle)) matches.add(isEpisode ? "series" : "title");
  const year = c.feature.year ?? rel.year;
  let wrongYear = false;
  if (wanted.year != null && year != null) {
    if (year === wanted.year) matches.add("year");
    else if (!isEpisode) wrongYear = true;
  }
  const idMatch = !!wanted.imdbId && !!c.feature.imdbId && normId(wanted.imdbId) === normId(c.feature.imdbId);
  if (idMatch) {
    // subliminal: an id match implies the title/series and year (and, for episodes, season/episode).
    if (isEpisode) ["series", "year", "season", "episode"].forEach((m) => matches.add(m as Match));
    else ["title", "year"].forEach((m) => matches.add(m as Match));
    wrongYear = false;
  }
  if (wanted.fileName && normalizeRelease(wanted.fileName) === normalizeRelease(c.release)) matches.add("hash");

  // Release details.
  if (wanted.releaseGroup && rel.releaseGroup) {
    const want = groupsOf(wanted.releaseGroup);
    if ([...groupsOf(rel.releaseGroup)].some((g) => want.has(g))) matches.add("release_group");
  }
  if (wanted.streamingService && wanted.streamingService === rel.streamingService) matches.add("streaming_service");
  if (wanted.source && wanted.source === rel.source) matches.add("source");
  if (wanted.resolution && wanted.resolution === rel.resolution) matches.add("resolution");
  if (wanted.videoCodec && wanted.videoCodec === rel.videoCodec) matches.add("video_codec");
  if (wanted.audioCodec && wanted.audioCodec === rel.audioCodec) matches.add("audio_codec");
  if (fpsMatches(wanted.fps, c.fps)) matches.add("fps");

  // subliminal: on a hash (exact release) match, nothing else counts.
  const counted: Set<Match> = matches.has("hash") ? new Set<Match>(["hash"]) : matches;
  let score = 0;
  for (const m of counted) score += scores[m] ?? 0;

  if (matches.has("hash")) reasons.push("Exact release name");
  if (idMatch) reasons.push("IMDb ID");
  if (matches.has("title") || matches.has("series")) reasons.push("Title");
  if (matches.has("year")) reasons.push(`Year ${wanted.year}`);
  if (matches.has("season") || matches.has("episode")) reasons.push(episodeLabel(wanted.season, wanted.episode));
  if (matches.has("release_group")) reasons.push(`Release group ${rel.releaseGroup}`);
  if (matches.has("streaming_service")) reasons.push(rel.streamingService!);
  if (matches.has("source")) reasons.push(rel.source!);
  if (matches.has("resolution")) reasons.push(rel.resolution!);
  if (matches.has("video_codec")) reasons.push(rel.videoCodec!);
  if (matches.has("audio_codec")) reasons.push(`Audio ${rel.audioCodec}`);
  if (matches.has("fps")) reasons.push(`${c.fps} fps`);

  // Penalties.
  if (wrongYear) {
    penalty += 2 * scores.year!;
    reasons.push(`Different year (${year})`);
  }
  if (wanted.source && rel.source && wanted.source !== rel.source) reasons.push(`${rel.source}, not ${wanted.source}`);
  const languageOk = c.language === wanted.language;
  if (languageOk) reasons.push(c.language === "ar" ? "Arabic" : c.language);
  else {
    penalty += max / 2;
    reasons.push(`Language ${c.language}`);
  }
  if (c.hearingImpaired !== wanted.hearingImpaired) {
    penalty += scores.fps!;
    reasons.push(c.hearingImpaired ? "Hearing impaired" : "Not hearing impaired");
  }
  if (c.machineTranslated) {
    penalty += scores.release_group!;
    reasons.push("Machine translated");
  }

  // Popularity only breaks ties: always worth less than the smallest match (1 point).
  const popularity =
    0.9 *
    (0.6 * Math.min(1, Math.log10(c.downloads + 1) / 5) +
      0.25 * Math.min(1, (c.rating ?? 0) / 10) +
      0.15 * (c.trusted ? 1 : 0));
  if (c.downloads > 0) reasons.push(`${c.downloads.toLocaleString("en-US")} downloads`);
  if (c.trusted) reasons.push("Trusted uploader");

  const total = Math.max(0, score - penalty) + popularity;
  const identity =
    matches.has("hash") ||
    idMatch ||
    (isEpisode
      ? matches.has("series") && matches.has("season") && matches.has("episode")
      : matches.has("title") && matches.has("year"));
  return {
    ...c,
    score: Math.round(total * 100) / 100,
    percent: Math.round((Math.min(max, Math.max(0, score - penalty)) / max) * 100),
    confidence: identity && !wrongYear && languageOk ? "high" : "low",
    reasons,
  };
}

function normId(id: string): string {
  return id.replace(/^tt0*/i, "");
}

/** The candidate to apply without asking, or null when the host should choose. */
export function autoPick(ranked: Ranked[]): Ranked | null {
  const top = ranked[0];
  return top && top.confidence === "high" ? top : null;
}
