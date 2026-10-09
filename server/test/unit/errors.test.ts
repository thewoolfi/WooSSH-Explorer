import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError, API_STATUS, mapError, notFoundHandler, requestIdMiddleware } from '../../src/errors.js';
import { createLogger, redact, silentLogger } from '../../src/logger.js';

describe('ApiError', () => {
  it('uses the status from the contract table', () => {
    const cases: [ConstructorParameters<typeof ApiError>[0], number][] = [
      ['BAD_REQUEST', 400],
      ['NOT_FOUND', 404],
      ['CONFLICT', 409],
      ['AUTH_FAILED', 401],
      ['HOST_KEY_UNKNOWN', 409],
      ['HOST_KEY_MISMATCH', 409],
      ['CONNECT_FAILED', 502],
      ['SFTP_UNAVAILABLE', 502],
      ['SFTP_ERROR', 400],
      ['REMOTE_ERROR', 502],
      ['NOT_SUPPORTED', 501],
      ['INTERNAL', 500],
    ];
    for (const [code, status] of cases) {
      const err = new ApiError(code, 'x');
      assert.equal(err.status, status, `${code} should be ${status}`);
      assert.equal(err.code, code);
      assert.equal(API_STATUS[code], status);
    }
  });

  it('renders only the contract envelope', () => {
    const body = new ApiError('HOST_KEY_UNKNOWN', 'nope', { host: 'h', port: 22 }).toBody();
    assert.deepEqual(body, { error: { code: 'HOST_KEY_UNKNOWN', message: 'nope', details: { host: 'h', port: 22 } } });
    assert.deepEqual(new ApiError('INTERNAL', 'boom').toBody(), { error: { code: 'INTERNAL', message: 'boom' } });
    assert.ok(!('stack' in body.error));
  });
});

describe('mapError', () => {
  it('passes an ApiError through untouched', () => {
    const original = new ApiError('NOT_FOUND', 'gone');
    assert.equal(mapError(original), original);
  });

  it('maps numeric ssh2 SFTP status codes to SFTP_ERROR with details.code', () => {
    const err = Object.assign(new Error('No such file'), { code: 2 });
    const mapped = mapError(err);
    assert.equal(mapped.code, 'SFTP_ERROR');
    assert.equal(mapped.status, 400);
    assert.equal(mapped.details?.['code'], 2);
  });

  it('maps socket errno codes to CONNECT_FAILED with details.reason', () => {
    for (const reason of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH']) {
      const err = Object.assign(new Error('connect failed'), { code: reason });
      const mapped = mapError(err);
      assert.equal(mapped.code, 'CONNECT_FAILED', reason);
      assert.equal(mapped.status, 502);
      assert.equal(mapped.details?.['reason'], reason);
    }
  });

  it('recognises authentication failures from the message', () => {
    const mapped = mapError(new Error('All configured authentication methods failed'));
    assert.equal(mapped.code, 'AUTH_FAILED');
    assert.equal(mapped.status, 401);
  });

  it('recognises a refused sftp subsystem', () => {
    assert.equal(mapError(new Error('Unable to request SFTP subsystem')).code, 'SFTP_UNAVAILABLE');
    assert.equal(mapError(new Error('subsystem sftp not supported')).code, 'SFTP_UNAVAILABLE');
  });

  it('recognises handshake failures', () => {
    const mapped = mapError(new Error('Handshake failed: no matching key exchange algorithm'));
    assert.equal(mapped.code, 'CONNECT_FAILED');
    assert.equal(mapped.details?.['reason'], 'KEX_NEGOTIATION_FAILED');
  });

  it('never leaks an unknown error as anything but INTERNAL', () => {
    const mapped = mapError(new Error('something deeply weird happened at /home/secret/path'));
    assert.equal(mapped.code, 'INTERNAL');
    assert.equal(mapped.status, 500);
    assert.equal(mapped.message, 'Unexpected server error.');
    assert.ok(!mapped.message.includes('secret'));
  });

  it('handles non-Error throwables', () => {
    assert.equal(mapError('plain string').code, 'INTERNAL');
    assert.equal(mapError(undefined).code, 'INTERNAL');
    assert.equal(mapError(null).code, 'INTERNAL');
    assert.equal(mapError({ code: 'ENOENT', message: 'missing' }).code, 'SFTP_ERROR');
  });

  it('maps stream teardown errors to CONNECT_FAILED', () => {
    const mapped = mapError(Object.assign(new Error('premature'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
    assert.equal(mapped.code, 'CONNECT_FAILED');
  });
});

describe('logger redaction', () => {
  it('redacts private keys', () => {
    const output = redact('key is -----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----');
    assert.ok(!output.includes('abcdef'));
    assert.ok(output.includes('[redacted]'));
  });

  it('redacts password/passphrase style assignments', () => {
    const out = redact('password=hunter2 passphrase: "secret phrase" token=abc123');
    assert.ok(!out.includes('hunter2'));
    assert.ok(!out.includes('secret phrase'));
    assert.ok(!out.includes('abc123'));
  });

  it('redacts public key blobs', () => {
    const out = redact('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBlobHere user@host');
    assert.ok(!out.includes('AAAAC3NzaC1lZDI1NTE5'));
  });

  it('keeps ordinary text intact', () => {
    assert.equal(redact('connected to prod-web-01:22'), 'connected to prod-web-01:22');
  });

  it('does not emit anything at silent level', () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      silentLogger.error('should not appear');
      createLogger('error').error('should appear');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    }
    assert.equal(written.length, 1);
    assert.ok(written[0]?.includes('should appear'));
    assert.ok(written[0]?.includes('ERROR'));
  });
});

describe('requestIdMiddleware', () => {
  function fakeRes(): {
    locals: Record<string, unknown>;
    headers: Record<string, unknown>;
    setHeader(k: string, v: unknown): void;
    getHeader(k: string): unknown;
  } {
    const headers: Record<string, unknown> = {};
    return {
      locals: {},
      headers,
      setHeader(key: string, value: unknown) {
        headers[key.toLowerCase()] = value;
      },
      getHeader(key: string) {
        return headers[key.toLowerCase()];
      },
    };
  }

  it('sets x-request-id on every response', () => {
    let counter = 0;
    const middleware = requestIdMiddleware({ generate: () => `req-${++counter}` });
    const res = fakeRes();
    middleware({ get: () => undefined } as never, res as never, (() => undefined) as never);
    assert.equal(res.getHeader('x-request-id'), 'req-1');
  });

  it('honours a well-formed inbound id and rejects a hostile one', () => {
    const middleware = requestIdMiddleware({ generate: () => 'generated' });
    const okRes = fakeRes();
    middleware({ get: () => 'abc-123' } as never, okRes as never, (() => undefined) as never);
    assert.equal(okRes.getHeader('x-request-id'), 'abc-123');

    const badRes = fakeRes();
    middleware({ get: () => 'bad id with spaces' } as never, badRes as never, (() => undefined) as never);
    assert.equal(badRes.getHeader('x-request-id'), 'generated');
  });
});

describe('notFoundHandler', () => {
  it('turns an unknown route into a NOT_FOUND ApiError', () => {
    const handler = notFoundHandler();
    let captured: unknown;
    handler(
      { method: 'GET', path: '/api/nope' } as never,
      {} as never,
      ((err?: unknown) => {
        captured = err;
      }) as never,
    );
    assert.ok(captured instanceof ApiError);
    assert.equal((captured as ApiError).code, 'NOT_FOUND');
    assert.match((captured as ApiError).message, /GET \/api\/nope/);
  });
});
