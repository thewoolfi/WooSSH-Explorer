import { create } from 'zustand';
import {
  isDesktop,
  onEditEvent,
  openForEdit,
  resolveEdit,
  revealInFileManager,
  type EditDecision,
  type EditEvent,
} from '../lib/desktop';
import { useUiStore } from './uiStore';
import { useExplorerStore } from './explorerStore';

/** One file the user is editing locally, keyed by the shell's session id. */
export interface EditSession {
  sessionId: string;
  connectionId: string;
  name: string;
  remotePath: string;
  localPath: string;
  state: EditEvent['state'];
  /** Bytes of the edited copy waiting for a decision. */
  bytes?: number;
  message?: string;
  /** Destination proposed for "save as", pre-filled with a sibling name. */
  suggestedPath: string;
}

interface EditState {
  sessions: EditSession[];
  /** The session the prompt is currently asking about, if any. */
  prompting: string | null;
  busy: boolean;
  starting: boolean;

  start: (input: { connectionId: string; remotePath: string; name: string }) => Promise<void>;
  apply: (sessionId: string, decision: EditDecision) => Promise<void>;
  dismiss: (sessionId: string) => void;
  attach: () => () => void;
}

/** `report.txt` → `/dir/report (edited).txt` */
export function suggestSaveAs(remotePath: string): string {
  const slash = remotePath.lastIndexOf('/');
  const directory = slash <= 0 ? '/' : remotePath.slice(0, slash);
  const base = slash < 0 ? remotePath : remotePath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : '';
  return `${directory === '/' ? '' : directory}/${stem} (edited)${extension}`;
}

export const useEditStore = create<EditState>((set, get) => ({
  sessions: [],
  prompting: null,
  busy: false,
  starting: false,

  start: async ({ connectionId, remotePath, name }) => {
    if (!isDesktop) return;
    set({ starting: true });
    const push = useUiStore.getState().pushToast;
    try {
      const handle = await openForEdit({ connectionId, remotePath, name });
      set((state) => ({
        starting: false,
        sessions: [
          ...state.sessions.filter((s) => s.sessionId !== handle.sessionId),
          {
            sessionId: handle.sessionId,
            connectionId,
            name,
            remotePath,
            localPath: handle.localPath,
            state: 'opened',
            suggestedPath: suggestSaveAs(remotePath),
          },
        ],
      }));
      push({
        level: 'info',
        title: `Opened ${name} in the default application`,
        detail: 'Save it there and you will be asked what to do with the changes.',
      });
    } catch (error) {
      set({ starting: false });
      push({
        level: 'error',
        title: 'Could not open the file for editing',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  },

  apply: async (sessionId, decision) => {
    set({ busy: true });
    try {
      await resolveEdit(sessionId, decision);
    } finally {
      set({ busy: false });
    }
  },

  dismiss: (sessionId) =>
    set((state) => ({
      prompting: state.prompting === sessionId ? null : state.prompting,
      sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
    })),

  /** Subscribes to shell events; returns an unsubscribe function. */
  attach: () => {
    if (!isDesktop) return () => undefined;

    return onEditEvent((event) => {
      const ui = useUiStore.getState();

      set((state) => {
        const existing = state.sessions.find((s) => s.sessionId === event.sessionId);
        const next: EditSession = {
          sessionId: event.sessionId,
          connectionId: existing?.connectionId || event.connectionId,
          name: event.name,
          remotePath: event.remotePath,
          localPath: event.localPath,
          state: event.state,
          suggestedPath: existing?.suggestedPath ?? suggestSaveAs(event.remotePath),
          ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
          ...(event.message !== undefined ? { message: event.message } : {}),
        };
        const sessions = existing
          ? state.sessions.map((s) => (s.sessionId === event.sessionId ? next : s))
          : [...state.sessions, next];
        return {
          sessions,
          prompting: event.state === 'changed' ? event.sessionId : state.prompting,
        };
      });

      const session = get().sessions.find((s) => s.sessionId === event.sessionId);

      switch (event.state) {
        case 'changed':
          ui.pushToast({
            level: 'info',
            title: `${event.name} changed`,
            detail: 'Choose whether to send it back to the server.',
          });
          break;

        case 'uploaded': {
          ui.pushToast({
            level: 'success',
            title: `Saved ${event.name} to the server`,
            detail: event.target,
            action: { label: 'Show local copy', run: () => revealInFileManager(event.localPath) },
          });
          // Refresh every folder that shows either the original or the new path.
          const explorer = useExplorerStore.getState();
          for (const tab of explorer.tabs) {
            if (tab.kind !== 'files' || tab.connectionId !== session?.connectionId) continue;
            void explorer.refresh(tab.id);
          }
          break;
        }

        case 'error':
          ui.pushToast({
            level: 'error',
            title: `Could not save ${event.name}`,
            detail: event.message,
          });
          break;

        case 'cancelled':
          break;

        default:
          break;
      }
    });
  },
}));
