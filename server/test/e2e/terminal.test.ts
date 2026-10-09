/**
 * §9 WebSocket terminal + §11.8 — PTY bridging, input/output, resize, exit.
 * Every WebSocket interaction is bounded by a timeout and always closed.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { WsClient, startHarness, waitFor, type Harness } from '../support/harness.js';

let h!: Harness;
let connectionId!: string;

before(async () => {
  h = await startHarness();
  const trusted = await h.connectTrusting();
  connectionId = trusted.id;
});

after(async () => {
  await h?.close();
});

function terminalUrl(id: string, cols = 80, rows = 24): string {
  return `${h.baseUrl.replace(/^http/, 'ws')}/api/ws/terminal?connectionId=${encodeURIComponent(id)}&cols=${cols}&rows=${rows}`;
}

function outputText(socket: WsClient): string {
  return socket
    .framesOfType('output')
    .map((frame) => String(frame.data ?? ''))
    .join('');
}

describe('terminal', () => {
  test('echo hello round trip, resize and exit', async () => {
    const socket = await WsClient.open(terminalUrl(connectionId));
    try {
      // §9: the server announces the session.
      const ready = await socket.waitForFrame((f) => f.t === 'ready', { timeoutMs: 8_000, label: 'ready frame' });
      assert.equal(ready.term, 'xterm-256color');
      assert.equal(typeof ready.sessionId, 'string');
      await waitFor(() => h.mock.openShells === 1, { timeoutMs: 5_000, label: 'the mock to see one open shell' });

      socket.send({ t: 'input', data: 'echo hello\n' });
      await waitFor(() => outputText(socket).includes('hello'), {
        timeoutMs: 8_000,
        label: `terminal output containing "hello" (got ${JSON.stringify(outputText(socket))})`,
      });

      // Stronger: a command whose result cannot come from echoing the input.
      socket.send({ t: 'input', data: 'pwd\n' });
      await waitFor(() => outputText(socket).includes('/'), {
        timeoutMs: 8_000,
        label: 'terminal output containing the remote cwd',
      });

      // §9 resize must not break the session.
      socket.send({ t: 'resize', cols: 120, rows: 32 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(socket.closed, false, 'a resize must not close the terminal');
      socket.send({ t: 'input', data: 'echo after-resize\n' });
      await waitFor(() => outputText(socket).includes('after-resize'), {
        timeoutMs: 8_000,
        label: 'the terminal to keep working after a resize',
      });
      assert.ok(!socket.framesOfType('error').length, `unexpected error frame: ${JSON.stringify(socket.framesOfType('error'))}`);

      // Graceful exit: an exit frame or a clean close.
      socket.send({ t: 'input', data: 'exit\n' });
      const exitFrame = await socket
        .waitForFrame((f) => f.t === 'exit' || f.t === 'error', { timeoutMs: 6_000, label: 'exit frame' })
        .catch(() => null);
      if (exitFrame?.t === 'exit') {
        assert.equal(typeof exitFrame.code, 'number');
        assert.ok(['exited', 'closed', 'error'].includes(String(exitFrame.reason)));
      } else {
        await socket.waitForClose(6_000);
      }
      await waitFor(() => h.mock.openShells === 0, { timeoutMs: 6_000, label: 'the shell to be gone' });
    } finally {
      await socket.close();
    }
  });

  test('closing the socket closes the remote shell', async () => {
    const socket = await WsClient.open(terminalUrl(connectionId));
    await socket.waitForFrame((f) => f.t === 'ready' || f.t === 'output', { timeoutMs: 8_000, label: 'terminal start' });
    await waitFor(() => h.mock.openShells >= 1, { timeoutMs: 5_000, label: 'an open shell on the mock' });
    await socket.close();
    await waitFor(() => h.mock.openShells === 0, {
      timeoutMs: 8_000,
      label: 'the mock shell to be closed when the socket closes',
    });
  });

  test('a terminal for an unknown connection reports an error instead of hanging', async () => {
    const socket = await WsClient.open(terminalUrl('conn-does-not-exist'));
    try {
      const outcome = await Promise.race([
        socket.waitForFrame((f) => f.t === 'error', { timeoutMs: 6_000, label: 'terminal error frame' }).then(() => 'error-frame'),
        socket.waitForClose(6_000).then(() => 'closed'),
      ]);
      assert.ok(['error-frame', 'closed'].includes(outcome), `expected an error frame or a close, got ${outcome}`);
      if (outcome === 'error-frame') {
        const frame = socket.framesOfType('error')[0]!;
        assert.equal(typeof frame.code, 'string');
        assert.equal(typeof frame.message, 'string');
      }
    } finally {
      await socket.close();
    }
  });

  test('the terminal survives a connection that also runs fs and exec calls', async () => {
    const socket = await WsClient.open(terminalUrl(connectionId));
    try {
      await socket.waitForFrame((f) => f.t === 'ready' || f.t === 'output', { timeoutMs: 8_000, label: 'terminal start' });
      const listing = await h.json('GET', `/api/connections/${connectionId}/fs/list?path=%2F`);
      assert.equal(listing.status, 200, 'fs/list must work while a shell is open');
      const exec = await h.json('POST', `/api/connections/${connectionId}/exec`, { command: 'echo parallel' });
      assert.equal(exec.status, 200);
      assert.equal(exec.json.stdout, 'parallel\n');

      socket.send({ t: 'input', data: 'echo still-alive\n' });
      await waitFor(() => outputText(socket).includes('still-alive'), {
        timeoutMs: 8_000,
        label: 'the shell to stay usable',
      });
    } finally {
      await socket.close();
    }
  });
});
