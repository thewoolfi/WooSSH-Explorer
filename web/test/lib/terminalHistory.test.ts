import { describe, expect, test } from 'vitest';
import { extractCommandFromLine, formatRelativeTime } from '../../src/lib/terminalHistory';

describe('extractCommandFromLine', () => {
  test('returns typed buffer when screen line ends with it', () => {
    expect(extractCommandFromLine('root@server:~# apt update -y', 'apt update -y')).toBe('apt update -y');
    expect(extractCommandFromLine('user@ubuntu:~$ docker ps', 'docker ps')).toBe('docker ps');
  });

  test('strips standard bash / sh prompt symbols', () => {
    expect(extractCommandFromLine('root@server:~# htop')).toBe('htop');
    expect(extractCommandFromLine('user@ubuntu:~$ ls -la')).toBe('ls -la');
    expect(extractCommandFromLine('user@box:% ping 8.8.8.8')).toBe('ping 8.8.8.8');
    expect(extractCommandFromLine('admin@router> show interfaces')).toBe('show interfaces');
  });

  test('handles complex prompts with paths and git branches', () => {
    expect(extractCommandFromLine('(env) alex@pc:~/dev/app$ npm run build')).toBe('npm run build');
    expect(extractCommandFromLine('➜  repo git:(main) git status')).toBe('git status');
  });

  test('returns empty string for bare prompts without commands', () => {
    expect(extractCommandFromLine('root@server:~# ')).toBe('');
    expect(extractCommandFromLine('user@ubuntu:~$ ')).toBe('');
    expect(extractCommandFromLine('root@server:~#')).toBe('');
  });

  test('falls back to typedBuffer or full line if no prompt symbol recognized', () => {
    expect(extractCommandFromLine('echo hello', 'echo hello')).toBe('echo hello');
    expect(extractCommandFromLine('custom command without prompt')).toBe('custom command without prompt');
  });
});

describe('formatRelativeTime', () => {
  const now = 1700000000000;

  test('formats seconds as "только что"', () => {
    expect(formatRelativeTime(now - 10000, now)).toBe('только что');
  });

  test('formats minutes', () => {
    expect(formatRelativeTime(now - 5 * 60 * 1000, now)).toBe('5 мин назад');
  });

  test('formats hours', () => {
    expect(formatRelativeTime(now - 3 * 3600 * 1000, now)).toBe('3 ч назад');
  });

  test('formats days', () => {
    expect(formatRelativeTime(now - 2 * 86400 * 1000, now)).toBe('2 дн назад');
  });
});
