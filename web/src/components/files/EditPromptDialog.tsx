import { useEffect, useState } from 'react';
import { useEditStore, type EditSession } from '../../state/editStore';
import { useUiStore } from '../../state/uiStore';
import { formatBytes } from '../../lib/format';
import { Button, Field, TextInput } from '../ui/Primitives';
import { Modal } from '../ui/Overlays';
import { Icon } from '../ui/Icon';

/**
 * The prompt shown after a file that was opened for editing has been saved
 * locally. It is deliberately a decision, not a notification: nothing is written
 * back to the server until the user picks overwrite or save-as.
 */
export function EditPromptDialog() {
  const sessions = useEditStore((s) => s.sessions);
  const prompting = useEditStore((s) => s.prompting);
  const busy = useEditStore((s) => s.busy);
  const apply = useEditStore((s) => s.apply);
  const dismiss = useEditStore((s) => s.dismiss);
  const pushToast = useUiStore((s) => s.pushToast);

  const session: EditSession | undefined = sessions.find((s) => s.sessionId === prompting);
  const [mode, setMode] = useState<'prompt' | 'save-as'>('prompt');
  const [target, setTarget] = useState('');

  useEffect(() => {
    if (!session) return;
    setMode('prompt');
    setTarget(session.suggestedPath);
  }, [session?.sessionId, session?.suggestedPath, session]);

  if (!session) return null;

  const close = () => dismiss(session.sessionId);

  const overwrite = () => {
    void apply(session.sessionId, { action: 'overwrite' }).finally(close);
  };

  const saveAs = () => {
    const path = target.trim();
    if (!path.startsWith('/')) {
      pushToast({ level: 'warn', title: 'Enter an absolute remote path, starting with /' });
      return;
    }
    void apply(session.sessionId, { action: 'save-as', remotePath: path }).finally(close);
  };

  return (
    <Modal
      open
      title={mode === 'save-as' ? 'Save as a different path' : `${session.name} changed`}
      subtitle={session.remotePath}
      onClose={close}
      width={540}
      footer={
        mode === 'save-as' ? (
          <>
            <Button variant="ghost" onClick={() => setMode('prompt')}>
              Back
            </Button>
            <span className="spacer" />
            <Button variant="primary" loading={busy} icon="upload" onClick={saveAs}>
              Save to server
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => void apply(session.sessionId, { action: 'cancel' }).finally(close)}>
              Cancel
            </Button>
            <span className="spacer" />
            <Button variant="secondary" icon="copy" onClick={() => setMode('save-as')}>
              Save as…
            </Button>
            <Button variant="primary" loading={busy} icon="upload" onClick={overwrite}>
              Overwrite on server
            </Button>
          </>
        )
      }
    >
      {mode === 'save-as' ? (
        <>
          <p className="dialog__text">
            The file stays on your PC; the edited copy is uploaded to the path below. Nothing is
            deleted on the server.
          </p>
          <Field label="Remote path" htmlFor="edit-target" hint="Absolute path on the server.">
            <TextInput
              id="edit-target"
              value={target}
              autoFocus
              mono
              spellCheck={false}
              onChange={(event) => setTarget(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && saveAs()}
            />
          </Field>
        </>
      ) : (
        <>
          <p className="dialog__text">
            You saved changes to this file in your local application. Send them back to the server?
          </p>

          <dl className="editfacts">
            <div>
              <dt className="label">Local copy</dt>
              <dd className="mono truncate" title={session.localPath}>
                {session.localPath}
              </dd>
            </div>
            <div>
              <dt className="label">Size</dt>
              <dd className="mono">{session.bytes !== undefined ? formatBytes(session.bytes) : '—'}</dd>
            </div>
          </dl>

          <p className="editwarn">
            <Icon name="alert" size={14} />
            <span>
              Overwriting replaces <code className="mono">{session.remotePath}</code> on the server.
              This cannot be undone.
            </span>
          </p>
        </>
      )}
    </Modal>
  );
}
