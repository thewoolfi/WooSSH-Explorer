import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FtpConnection } from '../../src/ftp/FtpConnection.js';
import { FtpFs } from '../../src/ftp/FtpFs.js';
import { createLogger } from '../../src/logger.js';

describe('FtpConnection and FtpFs', () => {
  const logger = createLogger('silent');

  it('initialises FtpConnection with ftp protocol and password authMethod', () => {
    const conn = new FtpConnection({
      host: 'ftp.example.com',
      port: 21,
      username: 'ftpuser',
      password: 'secret',
      label: 'My FTP',
      color: 'sky',
      logger,
    });

    assert.equal(conn.protocol, 'ftp');
    assert.equal(conn.authMethod, 'password');
    assert.equal(conn.host, 'ftp.example.com');
    assert.equal(conn.port, 21);
    assert.equal(conn.username, 'ftpuser');

    const summary = conn.summary();
    assert.equal(summary.protocol, 'ftp');
    assert.equal(summary.authMethod, 'password');
    assert.equal(summary.status, 'connecting');
    assert.equal(summary.hostKeyFingerprint, '');
  });

  it('rejects exec and shell with NOT_SUPPORTED ApiError', async () => {
    const conn = new FtpConnection({
      host: 'ftp.example.com',
      logger,
    });

    await assert.rejects(
      async () => conn.exec('uname -a'),
      (err: any) => err.code === 'NOT_SUPPORTED',
    );

    await assert.rejects(
      async () => conn.shell(),
      (err: any) => err.code === 'NOT_SUPPORTED',
    );
  });

  it('resolves remote paths correctly in FtpFs', async () => {
    const conn = new FtpConnection({
      host: 'ftp.example.com',
      logger,
    });
    const fs = new FtpFs(conn, logger);

    assert.equal(await fs.resolve('/var/log'), '/var/log');
    assert.equal(await fs.resolve('sub/dir', '/var/log'), '/var/log/sub/dir');
    assert.equal(await fs.resolve(''), '/');
    assert.equal(await fs.resolve('~'), '/');
    assert.equal(await fs.resolve('~/uploads'), '/uploads');
    assert.equal(await fs.normalize('/foo/bar/../baz'), '/foo/baz');
  });
});
