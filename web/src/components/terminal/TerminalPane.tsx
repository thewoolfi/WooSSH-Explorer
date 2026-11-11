import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { terminalSocketUrl } from '../../api/client';
import type { TerminalServerFrame } from '../../api/types';
import { readClipboardText, writeClipboardText } from '../../lib/desktop';
import {
  classifyTerminalKeyAction,
  shouldHandleTerminalMousePaste,
} from '../../lib/terminalClipboard';
import {
  resolveTerminalSize,
  shouldSendTerminalResize,
  type TerminalSize,
} from '../../lib/terminalResize';
import { useUiStore } from '../../state/uiStore';
import { useT } from '../../i18n/useT';
import { Icon } from '../ui/Icon';
import { IconButton, StatusDot } from '../ui/Primitives';
import { Button } from '../ui/Primitives';
import { TerminalInspector } from './TerminalInspector';

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
  tabId,
  visible = true,
}: {
  connectionId: string;
  title: string;
  /** Directory to move the shell into once it has started. */
  cwd?: string;
  tabId?: string;
  /** Whether the tab panel is currently visible in the layout. */
  visible?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const syncSizeRef = useRef<((forceSend?: boolean) => void) | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const theme = useUiStore((s) => s.theme);
  const terminalFontSize = useUiStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useUiStore((s) => s.setTerminalFontSize);
  const copyOnSelect = useUiStore((s) => s.copyOnSelect);
  const setCopyOnSelect = useUiStore((s) => s.setCopyOnSelect);
  const inspectorOpen = useUiStore((s) => s.isInspectorOpen(tabId));
  const setInspector = useUiStore((s) => s.setInspector);
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const setInspectorWidth = useUiStore((s) => s.setInspectorWidth);
  const resetInspectorWidth = useUiStore((s) => s.resetInspectorWidth);
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

    // Intercept wheel events so mouse scrolling scrolls the terminal buffer
    // instead of emitting escape sequences / arrow keys into the shell input.
    let wheelPartial = 0;
    term.attachCustomWheelEventHandler((event: WheelEvent) => {
      // In the normal buffer (shell prompt / stdout history) or when Shift is held,
      // scroll the terminal viewport directly and prevent sending escape sequences
      // or arrow keys to the remote shell stdin.
      if (term.buffer.active.type === 'normal' || event.shiftKey) {
        if (event.deltaY === 0) return false;
        let lines = 0;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
          lines = Math.round(event.deltaY);
        } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
          lines = Math.round(event.deltaY * term.rows);
        } else {
          // DOM_DELTA_PIXEL: accumulate fractional lines for smooth scrolling (~25px per line)
          const pixelsPerLine = 25;
          wheelPartial += event.deltaY / pixelsPerLine;
          if (Math.abs(wheelPartial) >= 1) {
            lines = Math.trunc(wheelPartial);
            wheelPartial -= lines;
          }
        }
        if (lines !== 0) {
          const multiplier = event.altKey ? (term.options.fastScrollSensitivity ?? 5) : 1;
          term.scrollLines(lines * multiplier);
        }
        return false;
      }
      // In alternate buffer without Shift (e.g. vim, nano, htop, less), let xterm
      // pass wheel events or arrow keys to the TUI application.
      return true;
    });
    term.open(host);
    terminalRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    const fitTerminal = (): TerminalSize | null => {
      if (disposed || !term.element) return null;
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return null;
      try {
        fit.fit();
      } catch {
        /* the pane can be zero-sized while a tab is hidden */
        return null;
      }
      return resolveTerminalSize(term.cols, term.rows);
    };

    // Fit before constructing the WebSocket URL so the SSH PTY opens at the
    // real pane dimensions instead of hardcoding 80x24.
    fitTerminal();
    const initialSize = resolveTerminalSize(term.cols, term.rows);
    let lastSentSize: TerminalSize | null = initialSize;

    const sendCurrentSize = (force = false) => {
      if (disposed) return;
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const next = resolveTerminalSize(term.cols, term.rows);
      if (!shouldSendTerminalResize(next, lastSentSize, force)) return;
      lastSentSize = next;
      socket.send(JSON.stringify({ t: 'resize', cols: next.cols, rows: next.rows }));
    };

    const syncSize = (forceSend = false) => {
      const fitted = fitTerminal();
      if (!fitted) return;
      sendCurrentSize(forceSend);
    };
    syncSizeRef.current = syncSize;

    let settleTimer: number | null = null;
    const scheduleSettleSync = () => {
      if (disposed) return;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        syncSize();
      }, 120);
    };

    const resizeDisposable = term.onResize(() => {
      sendCurrentSize();
    });

    const observer = new ResizeObserver(() => {
      syncSize();
      scheduleSettleSync();
    });
    observer.observe(host);

    const onWindowResize = () => {
      syncSize();
      scheduleSettleSync();
    };
    window.addEventListener('resize', onWindowResize);

    const raf = requestAnimationFrame(() => syncSize());
    if (typeof document.fonts?.ready?.then === 'function') {
      void document.fonts.ready.then(() => {
        if (!disposed) syncSize();
      });
    }

    const socket = new WebSocket(terminalSocketUrl(connectionId, initialSize.cols, initialSize.rows));
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
      syncSize();
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
        syncSize(true);
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

    let lastCustomPasteAt = 0;

    const pasteClipboard = async () => {
      if (disposed) return;
      const text = await readClipboardText();
      if (disposed || !text) return;
      if (socket.readyState === WebSocket.OPEN) {
        term.paste(text);
      }
      term.focus();
    };

    // PuTTY / terminal keyboard shortcuts:
    // - Shift+Insert / Ctrl+V / Ctrl+Shift+V / Cmd+V -> paste
    // - Ctrl+Insert / Ctrl+Shift+C / Cmd+C -> copy selection (keeps selection)
    // - Ctrl+C with active selection -> copy & clear selection; without selection -> SIGINT
    // - Bare Insert continues to send \x1b[2~ to vim / nano / shell.
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      const action = classifyTerminalKeyAction(event, term.hasSelection());
      if (action === 'none') return true;

      event.preventDefault();
      if (event.type === 'keydown') {
        event.stopPropagation();
        if (action === 'paste') {
          lastCustomPasteAt = Date.now();
          void pasteClipboard();
        } else {
          const selected = term.getSelection();
          if (selected) void writeClipboardText(selected);
          if (action === 'copy-and-clear') term.clearSelection();
        }
      }
      return false;
    });

    // Guard against Chromium firing a duplicate synthetic `paste` event on the
    // hidden textarea right after keydown already triggered our custom paste.
    const onHostPasteCapture = (event: ClipboardEvent) => {
      if (Date.now() - lastCustomPasteAt < 250) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    host.addEventListener('paste', onHostPasteCapture, true);

    let isPointerSelecting = false;
    let copiedOnCurrentMouseUp = false;
    let selectionDebounceTimer: number | null = null;
    let pendingMousePaste: { button: number; x: number; y: number } | null = null;

    const copySelectionIfNonEmpty = () => {
      if (!useUiStore.getState().copyOnSelect) return;
      const text = term.getSelection();
      if (text) void writeClipboardText(text);
    };

    // PuTTY copy-on-select: non-mouse selections debounce cleanly, while pointer
    // drags copy once on LMB mouseup instead of hammering clipboard IPC mid-drag.
    const selection = term.onSelectionChange(() => {
      if (!useUiStore.getState().copyOnSelect) return;
      if (isPointerSelecting || copiedOnCurrentMouseUp) return;
      if (selectionDebounceTimer !== null) window.clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = window.setTimeout(() => {
        selectionDebounceTimer = null;
        copySelectionIfNonEmpty();
      }, 40);
    });

    // Scrollbar interaction support:
    // 1. Prevent xterm's internal element mousedown listener from calling e.preventDefault(),
    //    which cancels native scrollbar dragging and track paging.
    // 2. Prevent host mousedown listener from stealing focus to the hidden textarea,
    //    which aborts active scrollbar drag capture in Chromium.
    const isScrollbarEvent = (event: MouseEvent): boolean => {
      const vp = host.querySelector<HTMLElement>('.xterm-viewport');
      if (!vp) return false;
      if (event.target instanceof Node && vp.contains(event.target)) {
        return true;
      }
      const rect = vp.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right;
    };

    let isDraggingScrollbar = false;
    const viewport = host.querySelector<HTMLElement>('.xterm-viewport');

    const onViewportMouseDown = (event: MouseEvent) => {
      isDraggingScrollbar = true;
      // Stop propagation so xterm's listener on term.element cannot call e.preventDefault(),
      // allowing the browser to natively drag the scrollbar thumb or page the track.
      event.stopPropagation();
    };

    if (viewport) {
      viewport.addEventListener('mousedown', onViewportMouseDown);
    }

    // Intercept middle-click / right-click in capture phase before xterm or Chromium
    // initiates Windows autoscroll panning, TUI click reporting (unless Shift), or menus.
    const onHostMouseDownCapture = (event: MouseEvent) => {
      if (isScrollbarEvent(event)) return;
      if (
        shouldHandleTerminalMousePaste({
          button: event.button,
          shiftKey: event.shiftKey,
          mouseTrackingMode: term.modes.mouseTrackingMode,
        })
      ) {
        event.preventDefault();
        event.stopPropagation();
        pendingMousePaste = { button: event.button, x: event.clientX, y: event.clientY };
        term.focus();
        return;
      }
      if (event.button === 0) {
        isPointerSelecting = true;
        copiedOnCurrentMouseUp = false;
      }
    };
    host.addEventListener('mousedown', onHostMouseDownCapture, true);

    const onHostAuxClickCapture = (event: MouseEvent) => {
      if (isScrollbarEvent(event)) return;
      if (
        event.button === 1 &&
        shouldHandleTerminalMousePaste({
          button: event.button,
          shiftKey: event.shiftKey,
          mouseTrackingMode: term.modes.mouseTrackingMode,
        })
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    host.addEventListener('auxclick', onHostAuxClickCapture, true);

    const onHostContextMenuCapture = (event: MouseEvent) => {
      if (isScrollbarEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    host.addEventListener('contextmenu', onHostContextMenuCapture, true);

    const onWindowMouseUp = (event: MouseEvent) => {
      if (isDraggingScrollbar) {
        isDraggingScrollbar = false;
        term.focus();
      }
      if (isPointerSelecting && event.button === 0) {
        isPointerSelecting = false;
        if (selectionDebounceTimer !== null) {
          window.clearTimeout(selectionDebounceTimer);
          selectionDebounceTimer = null;
        }
        copiedOnCurrentMouseUp = true;
        copySelectionIfNonEmpty();
        window.setTimeout(() => {
          copiedOnCurrentMouseUp = false;
        }, 0);
      }
      if (pendingMousePaste && event.button === pendingMousePaste.button) {
        const origin = pendingMousePaste;
        pendingMousePaste = null;
        const insideHost = event.target instanceof Node && host.contains(event.target);
        const moved = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
        if (insideHost && moved <= 16 && !isScrollbarEvent(event)) {
          event.preventDefault();
          event.stopPropagation();
          void pasteClipboard();
        }
      }
    };
    window.addEventListener('mouseup', onWindowMouseUp);

    const onWindowBlur = () => {
      isDraggingScrollbar = false;
      isPointerSelecting = false;
      pendingMousePaste = null;
    };
    window.addEventListener('blur', onWindowBlur);

    // A terminal that does not hold focus silently swallows the first keystrokes.
    const focus = () => term.focus();
    focus();
    const rafFocus = requestAnimationFrame(focus);

    const onHostMouseDown = (event: MouseEvent) => {
      if (isScrollbarEvent(event)) return;
      focus();
    };
    host.addEventListener('mousedown', onHostMouseDown);

    const onHostWheel = (event: WheelEvent) => {
      if (term.element && !term.element.contains(event.target as Node)) {
        event.preventDefault();
        if (event.deltaY === 0) return;
        const lines = Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 25));
        term.scrollLines(lines);
      }
    };
    host.addEventListener('wheel', onHostWheel, { passive: false });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(rafFocus);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (selectionDebounceTimer !== null) window.clearTimeout(selectionDebounceTimer);
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      if (viewport) {
        viewport.removeEventListener('mousedown', onViewportMouseDown);
      }
      window.removeEventListener('mouseup', onWindowMouseUp);
      window.removeEventListener('blur', onWindowBlur);
      host.removeEventListener('paste', onHostPasteCapture, true);
      host.removeEventListener('mousedown', onHostMouseDownCapture, true);
      host.removeEventListener('auxclick', onHostAuxClickCapture, true);
      host.removeEventListener('contextmenu', onHostContextMenuCapture, true);
      host.removeEventListener('mousedown', onHostMouseDown);
      host.removeEventListener('wheel', onHostWheel);
      resizeDisposable.dispose();
      disposable.dispose();
      selection.dispose();
      if (socket.readyState === WebSocket.CONNECTING) {
        // Closing a connecting socket logs a browser warning; wait it out.
        socket.onopen = () => socket.close();
        socket.onmessage = null;
      } else {
        socket.close();
      }
      syncSizeRef.current = null;
      terminalRef.current = null;
      fitRef.current = null;
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
    const rafId = requestAnimationFrame(() => {
      syncSizeRef.current?.();
    });
    const id = window.setTimeout(() => {
      syncSizeRef.current?.();
    }, 50);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(id);
    };
  }, [inspectorOpen, inspectorWidth]);

  useEffect(() => {
    const term = terminalRef.current;
    if (term) term.options.fontSize = terminalFontSize;
    // Refit and sync PTY size after the cell metrics update.
    const rafId = requestAnimationFrame(() => {
      syncSizeRef.current?.();
    });
    const id = window.setTimeout(() => {
      syncSizeRef.current?.();
    }, 0);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(id);
    };
  }, [terminalFontSize]);

  useEffect(() => {
    if (!visible) return;
    const rafId = requestAnimationFrame(() => {
      syncSizeRef.current?.();
    });
    const id = window.setTimeout(() => {
      syncSizeRef.current?.();
    }, 50);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(id);
    };
  }, [visible]);

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
          icon="clipboard"
          label={t('term.copyOnSelectHint')}
          size={14}
          active={copyOnSelect}
          onClick={() => {
            setCopyOnSelect(!copyOnSelect);
            terminalRef.current?.focus();
          }}
        />
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
        <Button
          variant={inspectorOpen ? 'secondary' : 'ghost'}
          size="sm"
          icon="sliders"
          onClick={() => toggleInspector(tabId)}
          title={t(inspectorOpen ? 'topbar.hideInspector' : 'topbar.showInspector')}
        >
          {t('palette.toggleInspector')}
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

      <div className="tpane__body">
        <div className="tpane__host" ref={hostRef} />
        {inspectorOpen ? (
          <TerminalInspector
            connectionId={connectionId}
            width={inspectorWidth}
            onWidthChange={setInspectorWidth}
            onWidthReset={resetInspectorWidth}
            onClose={() => setInspector(false, tabId)}
            onRunCommand={(cmd) => {
              const socket = socketRef.current;
              if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ t: 'input', data: `${cmd.trim()}\r` }));
                terminalRef.current?.focus();
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
