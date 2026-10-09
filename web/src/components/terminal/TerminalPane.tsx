import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { terminalSocketUrl } from '../../api/client';
import type { TerminalServerFrame } from '../../api/types';
import { useUiStore } from '../../state/uiStore';
import { useT } from '../../i18n/useT';
import { Icon } from '../ui/Icon';
import { IconButton, StatusDot } from '../ui/Primitives';
import { Button } from '../ui/Primitives';

type ConnState = 'connecting' | 'open' | 'closed' | 'error';

const FONT_SIZES = [11, 12.5, 14, 16, 18];

/** Quotes a path for the remote shell using POSIX single-quote escaping. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string; palette: string[] } {
  const styles = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  const isLight = document.documentElement.dataset.theme === 'light';
  return {
    background: get('--surface-inset', isLight ? '#f6f7f9' : '#07090c'),
    foreground: get('--text', isLight ? '#14181d' : '#e6eaf0'),
    cursor: get('--accent', '#5ee6c4'),
    selectionBackground: isLight ? 'rgba(18,184,134,0.24)' : 'rgba(94,230,196,0.26)',
    palette: isLight
      ? ['#14181d', '#d92b31', '#0a7b3e', '#b46d05', '#2f7fe0', '#7c53d6', '#0f8ba8', '#6b7480',
         '#98a1ac', '#f2555a', '#12b886', '#f5a524', '#6ba8ff', '#b08cff', '#56c8e0', '#ffffff']
      : ['#0a0c10', '#f2555a', '#5ee6c4', '#f5a524', '#6ba8ff', '#b08cff', '#56c8e0', '#a7b0bc',
         '#6e7887', '#f76d72', '#74eccd', '#ffc45c', '#8fc0ff', '#c9aeff', '#7fd8ea', '#ffffff'],
  };
}

export function TerminalPane({
  connectionId,
  title,
  cwd,
}: {
  connectionId: string;
  title: string;
  /** Directory to move the shell into once it has started. */
  cwd?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const theme = useUiStore((s) => s.theme);
  const terminalFontSize = useUiStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useUiStore((s) => s.setTerminalFontSize);
  const copyOnSelect = useUiStore((s) => s.copyOnSelect);
  const { t } = useT();

  const [state, setState] = useState<ConnState>('connecting');
  const [detail, setDetail] = useState<string>('');
  const [attempt, setAttempt] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchInfo, setSearchInfo] = useState<string>('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    const term = new Terminal({
      fontFamily:
        "'JetBrains Mono', 'Cascadia Mono', 'Cascadia Code', 'SF Mono', Consolas, 'Liberation Mono', monospace",
      fontSize: useUiStore.getState().terminalFontSize,
      lineHeight: 1.35,
      letterSpacing: 0.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      allowProposedApi: true,
      theme: readTheme(),
      allowTransparency: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    terminalRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    const sendResize = () => {
      if (disposed || !term.element) return;
      try {
        fit.fit();
      } catch {
        /* the pane can be zero-sized while a tab is hidden */
        return;
      }
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    const observer = new ResizeObserver(() => sendResize());
    observer.observe(host);
    const raf = requestAnimationFrame(sendResize);

    const socket = new WebSocket(terminalSocketUrl(connectionId, term.cols || 80, term.rows || 24));
    socketRef.current = socket;
    setState('connecting');

    /** Moves the shell into the tab's directory once the remote side is ready. */
    const enterDirectory = () => {
      if (!cwd) return;
      // Wait for the prompt: writing immediately after `ready` races the login
      // shell's own startup output and the line can be swallowed.
      window.setTimeout(() => {
        if (disposed || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ t: 'input', data: `cd ${shellQuote(cwd)}\r` }));
      }, 350);
    };

    socket.onopen = () => {
      if (disposed) {
        socket.close();
        return;
      }
      setState('open');
      sendResize();
    };

    socket.onmessage = (event) => {
      if (disposed) return;
      if (typeof event.data !== 'string') return;
      let frame: TerminalServerFrame;
      try {
        frame = JSON.parse(event.data) as TerminalServerFrame;
      } catch {
        return;
      }
      if (frame.t === 'output') term.write(frame.data);
      else if (frame.t === 'ready') {
        setState('open');
        enterDirectory();
      } else if (frame.t === 'exit') {
        setState('closed');
        setDetail(frame.reason ?? t('term.sessionEnded'));
        term.write(`\r\n\x1b[38;5;245m[${t('term.sessionEnded')}${frame.reason ? `: ${frame.reason}` : ''}${frame.code != null ? ` (${frame.code})` : ''}]\x1b[0m\r\n`);
      } else if (frame.t === 'error') {
        setState('error');
        setDetail(frame.message);
        term.write(`\r\n\x1b[31m${frame.message}\x1b[0m\r\n`);
      }
    };

    socket.onclose = () => {
      if (disposed) return;
      setState((previous) => (previous === 'error' ? previous : 'closed'));
    };

    socket.onerror = () => {
      if (disposed) return;
      setState('error');
      setDetail(t('term.unreachable'));
    };

    const disposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'input', data }));
      }
    });

    // Copy-on-select mirrors the usual terminal behaviour; middle-click paste and
    // Ctrl/Cmd+C keep working because the handler never swallows the event.
    const selection = term.onSelectionChange(() => {
      if (!useUiStore.getState().copyOnSelect) return;
      const text = term.getSelection();
      if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
    });

    // A terminal that does not hold focus silently swallows the first keystrokes.
    const focus = () => term.focus();
    focus();
    const rafFocus = requestAnimationFrame(focus);
    host.addEventListener('mousedown', focus);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(rafFocus);
      observer.disconnect();
      host.removeEventListener('mousedown', focus);
      disposable.dispose();
      selection.dispose();
      if (socket.readyState === WebSocket.CONNECTING) {
        // Closing a connecting socket logs a browser warning; wait it out.
        socket.onopen = () => socket.close();
        socket.onmessage = null;
      } else {
        socket.close();
      }
      terminalRef.current = null;
      socketRef.current = null;
      searchRef.current = null;
      // xterm schedules a viewport refresh on a macrotask; detaching first and
      // disposing on the next tick lets that queued refresh complete instead of
      // throwing on the already-disposed renderer (visible in hidden documents).
      term.element?.remove();
      window.setTimeout(() => {
        try {
          term.dispose();
        } catch {
          /* already torn down */
        }
      }, 0);
    };
    // `t` is intentionally excluded: it only affects post-mount labels, and
    // re-running this effect on a language switch would drop the shell session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, cwd, attempt]);

  useEffect(() => {
    const term = terminalRef.current;
    if (term) term.options.theme = readTheme();
  }, [theme]);

  useEffect(() => {
    const term = terminalRef.current;
    if (term) term.options.fontSize = terminalFontSize;
    // Refit after the cell size changes.
    const id = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* hidden pane */
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [terminalFontSize]);

  const runSearch = useCallback(
    (direction: 'next' | 'prev') => {
      const search = searchRef.current;
      if (!search || !query) return;
      const options = { decorations: { matchOverviewRuler: '#5ee6c4', activeMatchColorOverviewRuler: '#ffc45c' } };
      const found = direction === 'next' ? search.findNext(query, options) : search.findPrevious(query, options);
      setSearchInfo(found ? '' : t('palette.noMatch'));
    },
    [query, t],
  );

  useEffect(() => {
    if (!searchOpen) return;
    // Ctrl/Cmd+F is handled by the shell hotkeys; this covers the pane's own bar.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSearchOpen(false);
      else if (event.key === 'Enter') runSearch(event.shiftKey ? 'prev' : 'next');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen, runSearch]);

  const statusTone = state === 'open' ? 'mint' : state === 'connecting' ? 'amber' : state === 'error' ? 'danger' : 'slate';
  const statusLabel =
    state === 'open'
      ? t('term.connected')
      : state === 'connecting'
        ? t('term.connecting')
        : state === 'error'
          ? t('term.error')
          : t('term.closed');

  return (
    <div className="tpane">
      <header className="tpane__bar hairline-b">
        <Icon name="terminal" size={14} />
        <span className="tpane__title truncate">{title}</span>
        <span className="tpane__status mono">
          <StatusDot tone={statusTone} pulse={state === 'connecting'} />
          {statusLabel}
        </span>
        <span className="spacer" />
        {detail && state !== 'open' ? <span className="tpane__detail truncate">{detail}</span> : null}
        <IconButton
          icon="search"
          label={t('term.search')}
          size={14}
          active={searchOpen}
          onClick={() => setSearchOpen((open) => !open)}
        />
        <select
          className="tpane__font"
          aria-label={t('term.fontSize')}
          title={t('term.fontSize')}
          value={terminalFontSize}
          onChange={(event) => setTerminalFontSize(Number(event.target.value))}
        >
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          onClick={() => {
            terminalRef.current?.reset();
            setSearchInfo('');
            setAttempt((n) => n + 1);
          }}
        >
          {t('term.reconnect')}
        </Button>
      </header>

      {searchOpen ? (
        <div className="tpane__search hairline-b">
          <Icon name="search" size={13} />
          <input
            className="tpane__searchinput mono"
            autoFocus
            value={query}
            placeholder={t('term.searchPlaceholder')}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchInfo('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                runSearch(event.shiftKey ? 'prev' : 'next');
              }
            }}
          />
          {searchInfo ? <span className="tpane__searchinfo">{searchInfo}</span> : null}
          <span className="spacer" />
          <IconButton icon="arrow-up" label={t('files.back')} size={13} onClick={() => runSearch('prev')} />
          <IconButton icon="arrow-down" label={t('files.forward')} size={13} onClick={() => runSearch('next')} />
          <IconButton icon="close" label={t('common.close')} size={13} onClick={() => setSearchOpen(false)} />
        </div>
      ) : null}

      <div className="tpane__host" ref={hostRef} />
    </div>
  );
}
