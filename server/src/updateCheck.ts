import type { Logger } from './logger.js';

/**
 * Update checking against GitHub Releases.
 *
 * Deliberately a *check*, not a silent self-replacing updater. An update that installs
 * itself is a large amount of code that cannot be exercised until a release actually
 * exists, and the failure mode of getting it wrong — replacing a working install with a
 * half-downloaded one — is worse than the inconvenience of a notification. This answers
 * "is there something newer?" truthfully, and the install path is the user's decision.
 */

export interface UpdateCheckResult {
  current: string;
  /** `null` when the repository has no published releases yet. */
  latest: string | null;
  hasUpdate: boolean;
  /** Release page, so the user can read the notes before downloading. */
  url: string | null;
  publishedAt: string | null;
  releaseName: string | null;
  /** Set when the check itself could not be completed; never a reason to fail the app. */
  error: string | null;
  checkedAt: number;
}

/**
 * Compares two dotted versions. Returns 1 when `a` is newer, -1 when `b` is newer, 0 when
 * they are equal.
 *
 * A leading `v` is ignored, and a pre-release suffix (`-beta.1`) makes a version *older*
 * than the same number without one — which is what semver says and what stops a beta
 * install from being told it is up to date.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { parts: number[]; prerelease: string | null } => {
    const cleaned = value.trim().replace(/^v/i, '');
    const [core, ...rest] = cleaned.split('-');
    const parts = (core ?? '')
      .split('.')
      .map((piece) => {
        const number = Number.parseInt(piece.replace(/[^0-9].*$/, ''), 10);
        return Number.isFinite(number) ? number : 0;
      });
    return { parts, prerelease: rest.length > 0 ? rest.join('-') : null };
  };

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    const one = left.parts[index] ?? 0;
    const two = right.parts[index] ?? 0;
    if (one !== two) return one > two ? 1 : -1;
  }

  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease > right.prerelease ? 1 : -1;
}

/** How long an answer is reused; the UI may ask freely without hammering the API. */
const CACHE_MS = 6 * 60 * 60 * 1000;

interface Cached {
  at: number;
  result: UpdateCheckResult;
}

let cache: Cached | null = null;

/** Exposed for tests: forget the cached answer. */
export function resetUpdateCache(): void {
  cache = null;
}

export interface UpdateCheckOptions {
  current: string;
  owner: string;
  repo: string;
  /** Injected so a test never touches the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Skip the cache; used by the explicit "check now" action. */
  force?: boolean;
  logger?: Logger;
}

export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  if (!options.force && cache !== null && Date.now() - cache.at < CACHE_MS) return cache.result;

  const { current, owner, repo } = options;
  const base: UpdateCheckResult = {
    current,
    latest: null,
    hasUpdate: false,
    url: `https://github.com/${owner}/${repo}/releases`,
    publishedAt: null,
    releaseName: null,
    error: null,
    checkedAt: Date.now(),
  };

  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'WooSSH-Explorer',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });

    if (response.status === 404) {
      // A repository with no releases is a normal state, not an error.
      const result = { ...base, error: null };
      cache = { at: Date.now(), result };
      return result;
    }
    if (!response.ok) {
      const result = { ...base, error: `GitHub answered ${response.status}.` };
      cache = { at: Date.now(), result };
      return result;
    }

    const release = (await response.json()) as {
      tag_name?: unknown;
      name?: unknown;
      html_url?: unknown;
      published_at?: unknown;
      draft?: unknown;
      prerelease?: unknown;
    };

    // A draft is not published; a pre-release should not be pushed at everyone.
    if (release.draft === true || release.prerelease === true) {
      const result = { ...base, error: null };
      cache = { at: Date.now(), result };
      return result;
    }

    const tag = typeof release.tag_name === 'string' ? release.tag_name : null;
    if (tag === null) {
      const result = { ...base, error: 'The latest release carries no tag.' };
      cache = { at: Date.now(), result };
      return result;
    }

    const result: UpdateCheckResult = {
      ...base,
      latest: tag.replace(/^v/i, ''),
      hasUpdate: compareVersions(tag, current) > 0,
      url: typeof release.html_url === 'string' ? release.html_url : base.url,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      releaseName: typeof release.name === 'string' ? release.name : null,
    };
    options.logger?.debug('update check', { current, latest: result.latest, hasUpdate: result.hasUpdate });
    cache = { at: Date.now(), result };
    return result;
  } catch (error) {
    // Offline, blocked, rate-limited: report it, but never take the application down.
    const result = {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    };
    // Not cached: a network blip should not hide the next real answer for six hours.
    return result;
  }
}
