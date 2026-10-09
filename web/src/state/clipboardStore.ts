import { create } from 'zustand';
import { parentRemotePath } from '../lib/path';

/**
 * The file clipboard.
 *
 * It is deliberately app-wide rather than per tab: copying in one folder and
 * pasting in another — or on another host — is the whole point. Nothing is
 * transferred when you copy; only the intent is remembered, and the bytes move
 * when you paste.
 */
export type ClipboardMode = 'copy' | 'cut';

export interface ClipboardEntry {
  /** Host the paths came from. */
  connectionId: string;
  paths: string[];
  mode: ClipboardMode;
}

export interface PastePlan {
  kind: 'copy' | 'move' | 'relay';
  /** Paths to move, relative to their own host. */
  sources: string[];
  /** Set for a relay: the host the bytes come from. */
  sourceConnectionId?: string;
  /** Sources that were dropped because they are already in the target folder. */
  alreadyHere: string[];
}

export type PasteRefusal = 'empty' | 'nothing-to-paste' | 'already-here';

export type PasteDecision = { ok: true; plan: PastePlan } | { ok: false; reason: PasteRefusal };

/**
 * Decides what a paste should do, without touching the network.
 *
 * Pure on purpose: every rule about hosts and folders is testable on its own, and the
 * component only has to render the answer.
 */
export function planPaste(input: {
  clipboard: ClipboardEntry | null;
  targetConnectionId: string;
  targetDir: string;
}): PasteDecision {
  const { clipboard, targetConnectionId, targetDir } = input;
  if (!clipboard || clipboard.paths.length === 0) return { ok: false, reason: 'empty' };

  // Pasting something into the folder it already lives in would mean copying a
  // path onto itself, which the server refuses — say so plainly instead.
  const alreadyHere: string[] = [];
  const candidates: string[] = [];
  for (const path of clipboard.paths) {
    if (parentRemotePath(path) === targetDir) alreadyHere.push(path);
    else candidates.push(path);
  }
  if (candidates.length === 0) return { ok: false, reason: 'already-here' };

  const sameHost = clipboard.connectionId === targetConnectionId;
  if (sameHost) {
    return {
      ok: true,
      plan: {
        kind: clipboard.mode === 'cut' ? 'move' : 'copy',
        sources: candidates,
        alreadyHere,
      },
    };
  }

  // Across hosts the bytes travel server-to-server; the relay mirrors whole trees.
  return {
    ok: true,
    plan: {
      kind: 'relay',
      sources: candidates,
      sourceConnectionId: clipboard.connectionId,
      alreadyHere,
    },
  };
}

/** Text form of the clipboard, so Ctrl+C also fills the system clipboard. */
export function clipboardAsText(entry: ClipboardEntry): string {
  return entry.paths.join('\n');
}

interface ClipboardState {
  entry: ClipboardEntry | null;
  /** Puts paths on the clipboard. */
  put: (entry: ClipboardEntry) => void;
  /** Clears it — after a cut lands, or when the user asks. */
  clear: () => void;
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  entry: null,
  put: (entry) => set({ entry }),
  clear: () => set({ entry: null }),
}));

/** True when this row is waiting to be moved by a paste. */
export function isPendingCut(
  entry: ClipboardEntry | null,
  connectionId: string,
  path: string,
): boolean {
  return (
    entry !== null &&
    entry.mode === 'cut' &&
    entry.connectionId === connectionId &&
    entry.paths.includes(path)
  );
}
