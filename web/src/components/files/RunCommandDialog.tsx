import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry } from '../../api/types';
import { api } from '../../api/client';
import { useUiStore } from '../../state/uiStore';
import { parentRemotePath } from '../../lib/path';
import { Button, Field, TextInput } from '../ui/Primitives';
import { Modal } from '../ui/Overlays';
import { Icon } from '../ui/Icon';

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  durationMs: number;
}

/**
 * Runs a one-off command on the remote host over the existing `exec` channel.
 *
 * This is deliberately not a shell: there is no PTY, no interactive input and no
 * shared state between runs, which is why the terminal tab still exists. It is
 * for "what does this file actually contain", "how much space is left" and
 * "which binary is this" without leaving the file browser.
 */
export function RunCommandDialog({
  open,
  connectionId,
  connectionLabel,
  cwd,
  entry,
  onClose,
}: {
  open: boolean;
  connectionId: string | null;
  connectionLabel?: string;
  cwd: string;
  entry: FileEntry | null;
  onClose: () => void;
}) {
  const pushToast = useUiStore((s) => s.pushToast);
  const [command, setCommand] = useState('');
  const [directory, setDirectory] = useState(cwd);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const defaultDirectory = entry ? (parentRemotePath(entry.path) ?? cwd) : cwd;

  useEffect(() => {
    if (!open) return;
    setDirectory(defaultDirectory);
    setResult(null);
    setError(null);
    setRunning(false);
    setCommand(entry ? suggestFor(entry) : '');
  }, [open, entry, defaultDirectory]);

  const suggestions = useMemo(() => {
    const base = [
      { label: 'List', command: 'ls -la' },
      { label: 'Disk usage here', command: 'du -sh . 2>/dev/null' },
      { label: 'Free space', command: 'df -h .' },
      { label: 'System', command: 'uname -a' },
      { label: 'Who am I', command: 'id' },
    ];
    if (!entry || entry.kind === 'directory') return base;
    return [
      { label: 'What is this', command: `file ${quote(entry.name)}` },
      { label: 'Stat', command: `stat ${quote(entry.name)}` },
      { label: 'Head', command: `head -n 40 ${quote(entry.name)}` },
      { label: 'Tail log', command: `tail -n 40 ${quote(entry.name)}` },
      ...base,
    ];
  }, [entry]);

  const run = useCallback(async () => {
    if (!connectionId) return;
    const trimmed = command.trim();
    if (!trimmed) {
      setError('Enter a command to run.');
      return;
    }
    setRunning(true);
    setError(null);
    const started = performance.now();
    try {
      // `cd` first so a relative path in the command means what the user sees.
      const wrapped = directory.trim()
        ? `cd ${quote(directory.trim())} && ${trimmed}`
        : trimmed;
      const response = await api.exec(connectionId, wrapped, 120_000);
      setResult({
        stdout: response.stdout,
        stderr: response.stderr,
        code: response.code,
        durationMs: Math.round(performance.now() - started),
      });
      requestAnimationFrame(() => outputRef.current?.scrollTo({ top: 0 }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }, [command, connectionId, directory]);

  const copyOutput = () => {
    if (!result) return;
    const text = [
      `$ ${command}`,
      result.stdout,
      result.stderr ? `--- stderr ---\n${result.stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    void navigator.clipboard
      ?.writeText(text)
      .then(() => pushToast({ level: 'success', title: 'Output copied' }))
      .catch(() => pushToast({ level: 'error', title: 'Clipboard unavailable' }));
  };

  return (
    <Modal
      open={open}
      title="Run a command on the server"
      subtitle={connectionLabel ? `On ${connectionLabel}` : undefined}
      onClose={onClose}
      width={640}
      footer={
        <>
          {result ? (
            <Button variant="ghost" size="md" icon="copy" onClick={copyOutput}>
              Copy output
            </Button>
          ) : null}
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={running} icon="terminal" onClick={() => void run()}>
            Run
          </Button>
        </>
      }
    >
      <Field label="Command" htmlFor="exec-command">
        <TextInput
          id="exec-command"
          value={command}
          autoFocus
          mono
          spellCheck={false}
          placeholder="ls -la"
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void run();
            }
          }}
        />
      </Field>

      <Field label="Working directory" htmlFor="exec-cwd" hint="The command runs here, so relative paths behave as they read.">
        <TextInput
          id="exec-cwd"
          value={directory}
          mono
          spellCheck={false}
          placeholder="/"
          onChange={(event) => setDirectory(event.target.value)}
        />
      </Field>

      <div className="suggest">
        {suggestions.map((item) => (
          <button
            key={item.label}
            type="button"
            className="suggest__item"
            title={item.command}
            onClick={() => setCommand(item.command)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="form-error">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </p>
      ) : null}

      {result ? (
        <div className="execout">
          <div className="execout__bar">
            <span className="label">Output</span>
            <span className="spacer" />
            <span className={`execout__code${result.code === 0 ? ' is-ok' : ' is-bad'}`}>
              exit {result.code ?? '—'}
            </span>
            <span className="execout__time mono">{result.durationMs} ms</span>
          </div>
          <div className="execout__body scroll-y" ref={outputRef}>
            {result.stdout ? <pre className="execout__text mono">{result.stdout}</pre> : null}
            {result.stderr ? <pre className="execout__text execout__text--err mono">{result.stderr}</pre> : null}
            {!result.stdout && !result.stderr ? (
              <p className="execout__empty">The command produced no output.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/** A sane starting command for the selected entry. */
function suggestFor(entry: FileEntry): string {
  const executable = (entry.mode & 0o111) !== 0;
  if (executable) return `./${quote(entry.name)}`;
  return `file ${quote(entry.name)}`;
}

/** POSIX single-quote escaping — the command string is passed to a remote shell. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
