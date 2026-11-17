import { beforeEach, describe, expect, test } from 'vitest';
import { useCommandHistoryStore, STORAGE_KEY } from '../../src/state/commandHistoryStore';

describe('useCommandHistoryStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useCommandHistoryStore.setState({ commands: [] });
  });

  test('adds commands and preserves MRU order', () => {
    const store = useCommandHistoryStore.getState();
    store.addCommand('echo first', 'conn-1');
    store.addCommand('echo second', 'conn-1');

    const cmds = useCommandHistoryStore.getState().commands;
    expect(cmds).toHaveLength(2);
    expect(cmds[0]?.command).toBe('echo second');
    expect(cmds[1]?.command).toBe('echo first');
  });

  test('deduplicates identical commands and moves to top', () => {
    const store = useCommandHistoryStore.getState();
    store.addCommand('docker ps', 'conn-1');
    store.addCommand('htop', 'conn-1');
    store.addCommand('docker ps', 'conn-1');

    const cmds = useCommandHistoryStore.getState().commands;
    expect(cmds).toHaveLength(2);
    expect(cmds[0]?.command).toBe('docker ps');
    expect(cmds[1]?.command).toBe('htop');
  });

  test('ignores empty commands', () => {
    const store = useCommandHistoryStore.getState();
    store.addCommand('   ', 'conn-1');
    store.addCommand('', 'conn-1');

    expect(useCommandHistoryStore.getState().commands).toHaveLength(0);
  });

  test('removes command by id', () => {
    const store = useCommandHistoryStore.getState();
    store.addCommand('cmd 1');
    store.addCommand('cmd 2');

    const targetId = useCommandHistoryStore.getState().commands[0]!.id;
    store.removeCommand(targetId);

    const cmds = useCommandHistoryStore.getState().commands;
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.command).toBe('cmd 1');
  });

  test('clears history', () => {
    const store = useCommandHistoryStore.getState();
    store.addCommand('cmd 1', 'conn-1');
    store.addCommand('cmd 2', 'conn-2');

    store.clearHistory('conn-1');
    expect(useCommandHistoryStore.getState().commands).toHaveLength(1);
    expect(useCommandHistoryStore.getState().commands[0]?.command).toBe('cmd 2');

    store.clearHistory();
    expect(useCommandHistoryStore.getState().commands).toHaveLength(0);
  });

  test('persists to localStorage', () => {
    const store = useCommandHistoryStore.getState();
    store.addCommand('persisted command', 'conn-1');

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed[0]?.command).toBe('persisted command');
  });
});
