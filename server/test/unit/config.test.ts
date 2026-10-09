/**
 * §10 configuration: the three token states plus `SSH_EXPLORER_NO_TOKEN`, and the paths the
 * server derives from the state directory.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { generateToken, loadConfig, resolveToken } from '../../src/config.js';

const ENV_KEYS = ['SSH_EXPLORER_TOKEN', 'SSH_EXPLORER_NO_TOKEN'] as const;

/** Runs `fn` with only the listed environment variables set, restoring them afterwards. */
function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('generateToken', () => {
  it('is URL-safe and long enough to be a shared secret', () => {
    const token = generateToken();
    assert.match(token, /^[A-Za-z0-9_-]+$/, 'the token must survive a URL query string');
    assert.ok(token.length >= 40, `expected at least 40 characters, got ${token.length}`);
    assert.notEqual(generateToken(), token, 'every run gets its own token');
  });
});

describe('resolveToken', () => {
  it('prefers an explicit override over the environment', () => {
    withEnv({ SSH_EXPLORER_TOKEN: 'from-env', SSH_EXPLORER_NO_TOKEN: '1' }, () => {
      assert.deepEqual(resolveToken('from-option'), { token: 'from-option', source: 'explicit' });
      // `createServer({ token: null })` is what the integration tests use.
      assert.deepEqual(resolveToken(null), { token: null, source: 'disabled' });
    });
  });

  it('reads SSH_EXPLORER_TOKEN when the option is absent', () => {
    withEnv({ SSH_EXPLORER_TOKEN: 'from-env' }, () => {
      assert.deepEqual(resolveToken(undefined), { token: 'from-env', source: 'explicit' });
    });
  });

  it('lets SSH_EXPLORER_NO_TOKEN win over a configured token', () => {
    withEnv({ SSH_EXPLORER_TOKEN: 'from-env', SSH_EXPLORER_NO_TOKEN: '1' }, () => {
      assert.deepEqual(resolveToken(undefined), { token: null, source: 'env-no-token' });
    });
  });

  it('generates a token when nothing is configured', () => {
    withEnv({}, () => {
      const first = resolveToken(undefined);
      assert.equal(first.source, 'generated');
      assert.ok(first.token !== null && first.token.length >= 40);
      assert.notEqual(resolveToken(undefined).token, first.token);
    });
  });

  it('only accepts truthy spellings of the opt-out', () => {
    withEnv({ SSH_EXPLORER_NO_TOKEN: '0' }, () => {
      assert.equal(resolveToken(undefined).source, 'generated', '"0" must not disable the token');
    });
    withEnv({ SSH_EXPLORER_NO_TOKEN: 'no' }, () => {
      assert.equal(resolveToken(undefined).source, 'generated');
    });
    withEnv({ SSH_EXPLORER_NO_TOKEN: 'true' }, () => {
      assert.equal(resolveToken(undefined).source, 'env-no-token');
    });
  });
});

describe('loadConfig', () => {
  const stateDir = path.join('ssh-explorer-config-test');
  const overrides = { stateDir };

  it('defaults to a generated token', () => {
    withEnv({}, () => {
      const config = loadConfig(overrides);
      assert.equal(config.tokenSource, 'generated');
      assert.ok(config.token !== null && config.token.length >= 40);
      assert.equal(config.settingsPath, path.resolve(path.join(stateDir, 'settings.json')));
      assert.equal(config.knownHostsPath, path.resolve(path.join(stateDir, 'known_hosts')));
      assert.equal(config.profilesPath, path.resolve(path.join(stateDir, 'profiles.json')));
    });
  });

  it('keeps an explicit token and reports it as explicit', () => {
    withEnv({ SSH_EXPLORER_TOKEN: 'shh' }, () => {
      const config = loadConfig(overrides);
      assert.equal(config.token, 'shh');
      assert.equal(config.tokenSource, 'explicit');
    });
  });

  it('turns the requirement off for SSH_EXPLORER_NO_TOKEN=1', () => {
    withEnv({ SSH_EXPLORER_NO_TOKEN: '1' }, () => {
      const config = loadConfig(overrides);
      assert.equal(config.token, null);
      assert.equal(config.tokenSource, 'env-no-token');
    });
  });

  it('honours an explicit null override even with a token in the environment', () => {
    withEnv({ SSH_EXPLORER_TOKEN: 'shh' }, () => {
      const config = loadConfig({ ...overrides, token: null });
      assert.equal(config.token, null);
      assert.equal(config.tokenSource, 'disabled');
    });
  });

  it('never treats an empty token as "no authentication"', () => {
    withEnv({ SSH_EXPLORER_TOKEN: '   ' }, () => {
      // An empty environment value is not a token: a fresh one is generated instead.
      assert.equal(loadConfig(overrides).tokenSource, 'generated');
    });
  });
});
