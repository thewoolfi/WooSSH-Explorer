import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkForUpdate, compareVersions, resetUpdateCache } from '../../src/updateCheck.js';

/**
 * The update check is the one thing in the application that talks to a third party. It
 * must never be able to break the app, and it must not lie in either direction: telling
 * someone they are up to date when they are not is as bad as nagging them forever.
 */
describe('compareVersions', () => {
  it('orders by number, not by text', () => {
    // The classic: "1.10.0" < "1.9.0" as strings, and it is newer as versions.
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.equal(compareVersions('10.0.0', '2.0.0'), 1);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
    assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
  });

  it('ignores a leading v, because release tags carry one', () => {
    assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
    assert.equal(compareVersions('V2.0.0', 'v1.9.9'), 1);
  });

  it('treats a pre-release as older than the release it precedes', () => {
    assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  });

  it('pads missing segments with zero', () => {
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.1', '1.0.9'), 1);
  });

  it('does not throw on nonsense', () => {
    // A tag can be anything; the check must survive it rather than crash the route.
    assert.doesNotThrow(() => compareVersions('nightly', '1.0.0'));
    assert.doesNotThrow(() => compareVersions('', ''));
  });
});

/** A stand-in for the GitHub API. */
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('checkForUpdate', () => {
  const base = { current: '1.0.0', owner: 'o', repo: 'r' };

  it('reports a newer release', async () => {
    resetUpdateCache();
    const result = await checkForUpdate({
      ...base,
      force: true,
      fetchImpl: fakeFetch(200, {
        tag_name: 'v1.1.0',
        name: 'Version 1.1.0',
        html_url: 'https://example.test/releases/1.1.0',
        published_at: '2026-01-02T00:00:00Z',
      }),
    });
    assert.equal(result.latest, '1.1.0');
    assert.equal(result.hasUpdate, true);
    assert.equal(result.url, 'https://example.test/releases/1.1.0');
    assert.equal(result.error, null);
  });

  it('reports being up to date without inventing an update', async () => {
    resetUpdateCache();
    const result = await checkForUpdate({
      ...base,
      force: true,
      fetchImpl: fakeFetch(200, { tag_name: '1.0.0' }),
    });
    assert.equal(result.hasUpdate, false);
    assert.equal(result.error, null);
  });

  it('treats a repository with no releases as normal, not as a failure', async () => {
    // This is the state of the project today; showing an error would be a lie.
    resetUpdateCache();
    const result = await checkForUpdate({ ...base, force: true, fetchImpl: fakeFetch(404, {}) });
    assert.equal(result.latest, null);
    assert.equal(result.hasUpdate, false);
    assert.equal(result.error, null);
    assert.match(result.url ?? '', /\/releases$/);
  });

  it('does not push a draft or a pre-release at everyone', async () => {
    resetUpdateCache();
    for (const flag of [{ draft: true }, { prerelease: true }]) {
      const result = await checkForUpdate({
        ...base,
        force: true,
        fetchImpl: fakeFetch(200, { tag_name: 'v9.9.9', ...flag }),
      });
      assert.equal(result.hasUpdate, false, `${JSON.stringify(flag)} must not be offered`);
      assert.equal(result.error, null);
    }
  });

  it('survives a network failure and says so', async () => {
    resetUpdateCache();
    const failing = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const result = await checkForUpdate({ ...base, force: true, fetchImpl: failing });
    assert.equal(result.hasUpdate, false);
    assert.match(result.error ?? '', /ENOTFOUND/);
  });

  it('reports an unexpected status rather than pretending', async () => {
    resetUpdateCache();
    const result = await checkForUpdate({ ...base, force: true, fetchImpl: fakeFetch(403, {}) });
    assert.equal(result.hasUpdate, false);
    assert.match(result.error ?? '', /403/);
  });

  it('does not cache a failure, so the next attempt is a real one', async () => {
    resetUpdateCache();
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await checkForUpdate({ ...base, fetchImpl: failing });
    // A second call without `force` must still go out, not reuse the error.
    const second = await checkForUpdate({ ...base, fetchImpl: fakeFetch(200, { tag_name: 'v2.0.0' }) });
    assert.equal(second.hasUpdate, true);
  });
});
