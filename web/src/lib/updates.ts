import { useCallback, useEffect } from 'react';
import { api } from '../api/client';
import { translate } from '../i18n';
import { updateBridge, openExternalLink } from './desktop';
import { useUiStore } from '../state/uiStore';

/**
 * Watches for a newer release and reports it in {@link useUiStore}.
 *
 * Two mechanisms, because the application ships in two shapes. The installed desktop
 * build updates itself through `electron-updater` — it can download and apply a release.
 * The portable build and the browser cannot replace themselves at all, so there the
 * server's release check is used and the answer is a link to the release page.
 *
 * The check is never allowed to fail loudly: being offline is not a problem worth a
 * dialog, and the state simply stays `idle`.
 */
/**
 * Runs the check once and records what it found.
 *
 * Standalone rather than a hook, so the command palette and the periodic watcher share one
 * implementation instead of mounting a second watcher beside the first.
 */
export async function runUpdateCheck(): Promise<void> {
  const setUpdate = useUiStore.getState().setUpdate;
  setUpdate({ phase: 'checking' });

  if (updateBridge.available) {
    const result = await updateBridge.check();
    if (result.supported) {
      // The shell reports through events; a `none` event resets the state, and an
      // `available` event raises it. Nothing to decide here.
      return;
    }
  }

  try {
    const release = await api.updateCheck(true);
    if (release.hasUpdate && release.latest !== null) {
      setUpdate({
        phase: 'available',
        version: release.latest,
        canInstall: false,
        url: release.url,
      });
    } else {
      setUpdate({ phase: 'idle' });
    }
  } catch {
    // Offline, or the API is not reachable yet: nothing worth saying.
    setUpdate({ phase: 'idle' });
  }
}

export function useUpdateWatch(): { checkNow: () => Promise<void> } {
  const setUpdate = useUiStore((s) => s.setUpdate);

  const checkNow = useCallback(() => runUpdateCheck(), []);

  useEffect(() => {
    const off = updateBridge.onEvent((event) => {
      switch (event.type) {
        case 'available':
          setUpdate({
            phase: 'available',
            version: event.version ?? null,
            canInstall: true,
            url: null,
          });
          break;
        case 'progress': {
          const current = useUiStore.getState().update;
          setUpdate({
            phase: 'downloading',
            version: current.phase === 'available' ? current.version : null,
            percent: event.percent ?? 0,
          });
          break;
        }
        case 'ready':
          setUpdate({ phase: 'ready', version: event.version ?? null });
          break;
        case 'none': {
          // A `none` means "you are current"; only clear a check that is still in flight,
          // so a finished download is not wiped by a stray event.
          const current = useUiStore.getState().update;
          if (current.phase === 'checking' || current.phase === 'available') {
            setUpdate({ phase: 'idle' });
          }
          break;
        }
        case 'error':
          // A failed update check is not worth interrupting anyone over.
          setUpdate({ phase: 'idle' });
          break;
        default:
          break;
      }
    });

    // After the first paint, so the check never competes with loading the application.
    const timer = window.setTimeout(() => void checkNow(), 4000);
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [checkNow, setUpdate]);

  return { checkNow };
}

/** Downloads the update, or opens the release page when the build cannot install it. */
export async function actOnUpdate(): Promise<void> {
  const { update, setUpdate } = useUiStore.getState();
  if (update.phase === 'ready') {
    await updateBridge.install();
    return;
  }
  if (update.phase !== 'available') return;

  if (!update.canInstall) {
    if (update.url !== null) openExternalLink(update.url);
    return;
  }
  setUpdate({ phase: 'downloading', version: update.version, percent: 0 });
  const result = await updateBridge.download();
  if (!result.ok) {
    useUiStore.getState().pushToast({
      level: 'error',
      title: translate('update.downloadFailed'),
      detail: result.error,
    });
    setUpdate({ phase: 'available', version: update.version, canInstall: true, url: null });
  }
}
