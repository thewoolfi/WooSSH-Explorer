/**
 * `GET /api/connections/:id/diagnostics` — the answer to "why is the panel empty".
 *
 * The report is meant to be copied and sent, so the assertions here are about it being
 * *useful*: every probe present, its exact command recorded, and a finding that names the
 * problem rather than restating it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { withHarness } from '../support/harness.js';

describe('connection diagnostics', () => {
  test('runs every probe and reports what each one answered', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;

      const res = await h.json('GET', `/api/connections/${connectionId}/diagnostics`);
      assert.equal(res.status, 200, res.text.slice(0, 300));
      const report = res.json;

      assert.equal(typeof report.collectedAt, 'number');
      assert.ok(report.checks.length >= 10, `expected the full probe list, got ${report.checks.length}`);
      assert.ok(Array.isArray(report.findings) && report.findings.length > 0);

      // Every row carries the command verbatim, so the report can be reproduced by hand.
      for (const check of report.checks) {
        assert.equal(typeof check.name, 'string');
        assert.ok(check.command.length > 0, `${check.name} recorded no command`);
        assert.equal(typeof check.ok, 'boolean');
        assert.equal(typeof check.durationMs, 'number');
      }

      const names = report.checks.map((check: { name: string }) => check.name);
      for (const required of ['shell', 'comment handling', 'platform', 'read /proc', 'status probe']) {
        assert.ok(names.includes(required), `the report is missing the ${required} probe`);
      }
    });
  });

  test('the shell probe declares `#` a comment, which is the bug this was built for', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      const report = (await h.json('GET', `/api/connections/${connectionId}/diagnostics`)).json;

      const comments = report.checks.find((check: { name: string }) => check.name === 'comment handling');
      assert.ok(comments, 'the comment probe must be present');
      // A POSIX shell prints a blank line for the unquoted form, the marker for the quoted one.
      const lines = comments.output.split('\n');
      assert.equal(lines[0]?.trim(), '', 'the unquoted marker must come back as a comment');
      assert.equal(lines[1]?.trim(), '###SSHX-DIAG', 'the quoted marker must survive');
    });
  });

  test('names a missing tool instead of leaving the reader to guess', async () => {
    await withHarness({ mock: { missingCommands: ['tar', 'unzip'] } }, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      const report = (await h.json('GET', `/api/connections/${connectionId}/diagnostics`)).json;

      const findings = report.findings.join('\n');
      assert.match(findings, /`tar` is not installed/);
      assert.match(findings, /`unzip` is not installed/);
      // `zip` is installed in this run, so it must not be reported as missing.
      assert.equal(/`zip` is not installed/.test(findings), false);
    });
  });

  test('the copyable text contains the findings and every command', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      const report = (await h.json('GET', `/api/connections/${connectionId}/diagnostics`)).json;

      assert.ok(report.text.startsWith('SSH Explorer — connection diagnostics'));
      assert.ok(report.text.includes('Findings'));
      for (const finding of report.findings) {
        assert.ok(report.text.includes(finding), 'each finding appears in the pasted report');
      }
      assert.ok(report.text.includes('$ uname -srm'), 'the exact probe command is recorded');
    });
  });

  test('is refused for a connection that is not authenticated', async () => {
    await withHarness({}, async (h) => {
      const res = await h.json('GET', '/api/connections/conn_missing/diagnostics');
      assert.equal(res.status, 404);
    });
  });
});
