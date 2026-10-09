import { useEffect, useMemo, useState } from 'react';
import type { AuthMethod, HostKeyChallenge, SavedProfile } from '../../api/types';
import { HOST_COLORS } from '../../api/types';
import { ApiError } from '../../api/client';
import { nextHostColor, useConnectionStore } from '../../state/connectionStore';
import { useUiStore } from '../../state/uiStore';
import { formatRelative } from '../../lib/format';
import { Button, Field, Segmented, StatusDot, TextInput } from '../ui/Primitives';
import { Modal } from '../ui/Overlays';
import { Icon } from '../ui/Icon';
import { useT } from '../../i18n/useT';

interface FormState {
  label: string;
  host: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  password: string;
  privateKeyPath: string;
  passphrase: string;
  agentSocket: string;
  color: string;
  /** Save the host to the sidebar. */
  save: boolean;
  /** Persist the credential in the encrypted vault. */
  saveSecret: boolean;
  /** Connect with a credential already in the vault instead of typing one. */
  useSaved: boolean;
}

const EMPTY: FormState = {
  label: '',
  host: '',
  port: '22',
  username: '',
  authMethod: 'privateKey',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  agentSocket: '',
  color: 'mint',
  save: true,
  saveSecret: true,
  useSaved: false,
};

export function ConnectionDialog() {
  const dialog = useUiStore((s) => s.connectionDialog);
  const close = useUiStore((s) => s.closeConnectionDialog);
  const pushToast = useUiStore((s) => s.pushToast);
  const challenge = useUiStore((s) => s.hostKeyChallenge);
  const setChallenge = useUiStore((s) => s.setHostKeyChallenge);

  const systemInfo = useConnectionStore((s) => s.systemInfo);
  const profiles = useConnectionStore((s) => s.profiles);
  const connect = useConnectionStore((s) => s.connect);
  const updateProfile = useConnectionStore((s) => s.updateProfile);
  const deleteProfile = useConnectionStore((s) => s.deleteProfile);
  const secrets = useConnectionStore((s) => s.secrets);
  const secretStorage = useConnectionStore((s) => s.secretStorage);
  const forgetSecret = useConnectionStore((s) => s.forgetSecret);
  const connections = useConnectionStore((s) => s.connections);
  const openConnectionDialog = useUiStore((s) => s.openConnectionDialog);
  const { t } = useT();

  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [pending, setPending] = useState<FormState | null>(null);

  const editing: SavedProfile | null = dialog.profile;

  /** The vault entry for whatever host/user is currently typed in. */
  const storedEntry = useMemo(() => {
    const host = form.host.trim();
    const username = form.username.trim();
    if (!host || !username) return undefined;
    return secrets.find(
      (entry) => entry.host === host && entry.port === (Number(form.port) || 22) && entry.username === username,
    );
  }, [form.host, form.username, form.port, secrets]);

  useEffect(() => {
    if (!dialog.open) return;
    const host = dialog.host ?? dialog.profile?.host ?? '';
    const port = dialog.port ?? dialog.profile?.port ?? 22;
    const username = dialog.username ?? dialog.profile?.username ?? '';
    const hasStored = useConnectionStore.getState().storedSecretFor(host, port, username) !== undefined;

    setForm({
      ...EMPTY,
      host,
      port: String(port),
      username,
      authMethod: dialog.profile?.authMethod ?? (systemInfo?.keys.length ? 'privateKey' : 'password'),
      privateKeyPath: dialog.profile?.privateKeyPath ?? systemInfo?.keys[0]?.path ?? '',
      label: dialog.profile?.label ?? '',
      color: dialog.profile?.color ?? nextHostColor(profiles),
      save: true,
      saveSecret: true,
      // When the credential is already in the vault, reuse it rather than
      // asking for a password again.
      useSaved: hasStored,
    });
    setError(null);
    setAdvanced(false);
    setPending(null);
  }, [dialog, profiles, systemInfo]);

  /**
   * A saved credential is offered, never forced: the card and the "use the saved
   * credentials" checkbox appear as soon as the host triple matches, but the form
   * is not rewritten underneath the user while they are typing. The checkbox
   * starts ticked only when the dialog was opened for a host that has one.
   */

  const keys = systemInfo?.keys ?? [];
  const patch = (part: Partial<FormState>) => setForm((f) => ({ ...f, ...part }));

  /** The `auth` block for a form, or `undefined` to let the vault supply it. */
  const authFor = (current: FormState) => {
    if (current.useSaved) return undefined;
    if (current.authMethod === 'password') {
      return { method: 'password' as const, password: current.password };
    }
    if (current.authMethod === 'agent') {
      return { method: 'agent' as const, ...(current.agentSocket ? { socket: current.agentSocket } : {}) };
    }
    return {
      method: 'privateKey' as const,
      ...(current.privateKeyPath ? { privateKeyPath: current.privateKeyPath } : {}),
      ...(current.passphrase ? { passphrase: current.passphrase } : {}),
    };
  };

  const submit = async (current: FormState, trust: { fingerprint: string } | null) => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await connect({
        host: current.host.trim(),
        port: Number(current.port) || 22,
        username: current.username.trim(),
        label: current.label.trim() || undefined,
        color: current.color,
        ...(authFor(current) !== undefined ? { auth: authFor(current) } : {}),
        ...(current.useSaved ? { useStoredSecret: true } : {}),
        ...(current.saveSecret && !current.useSaved ? { saveSecret: true } : {}),
        ...(trust ? { trustHostKey: true, hostKeyFingerprint: trust.fingerprint } : {}),
      });
      const { connection, savedSecret, usedStoredSecret } = outcome;

      if (editing) {
        await updateProfile(editing.id, {
          label: connection.label,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          authMethod: connection.authMethod,
          privateKeyPath:
            current.authMethod === 'privateKey' ? current.privateKeyPath : undefined,
          color: current.color,
        }).catch(() => undefined);
      } else if (current.save) {
        await useConnectionStore
          .getState()
          .saveProfile({
            label: connection.label,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            authMethod: connection.authMethod,
            privateKeyPath: current.authMethod === 'privateKey' ? current.privateKeyPath : undefined,
            color: current.color,
          })
          .catch(() => undefined);
      }

      pushToast({
        level: 'success',
        title: `Connected to ${connection.label}`,
        detail: connection.serverInfo
          ? `${connection.serverInfo.platform} ${connection.serverInfo.release} В· ${connection.serverInfo.arch}`
          : undefined,
      });
      setChallenge(null);
      setPending(null);
      close();
      if (connection.serverInfo?.home) {
        useUiStore.getState().setInspector(true);
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'HOST_KEY_UNKNOWN') {
        const details = caught.details as unknown as HostKeyChallenge;
        setPending(current);
        setChallenge({
          host: details.host ?? current.host,
          port: details.port ?? Number(current.port),
          fingerprint: details.fingerprint,
          keyType: details.keyType ?? '',
          algorithm: details.algorithm ?? '',
          knownHostsPath: details.knownHostsPath ?? '',
        });
      } else if (caught instanceof ApiError && caught.code === 'HOST_KEY_MISMATCH') {
        setError(
          `The host key changed since the last connection. Remove the old entry from ${String(
            caught.details.knownHostsPath ?? 'known_hosts',
          )} only if you trust this change.`,
        );
      } else if (caught instanceof ApiError && caught.code === 'AUTH_FAILED') {
        setError('Authentication failed. Check the username and credentials.');
      } else if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = () => {
    if (!form.host.trim()) return setError('Enter a host name or address.');
    if (!form.username.trim()) return setError('Enter a user name.');
    if (!form.useSaved) {
      if (form.authMethod === 'password' && !form.password) {
        return setError('Enter the password, or switch to private key authentication.');
      }
      if (form.authMethod === 'privateKey' && !form.privateKeyPath) {
        return setError('Choose a private key file.');
      }
    }
    setError(null);
    void submit(form, null);
  };

  const canRemove = Boolean(editing);

  return (
    <>
      <Modal
        open={dialog.open && !challenge}
        title={editing ? 'Edit connection' : 'New connection'}
        subtitle={
          editing
            ? secretStorage
              ? secretStorage.kind === 'os-keychain'
                ? 'Saved credentials are sealed by your operating system account.'
                : 'Saved credentials are encrypted before they are written to disk.'
              : 'Credentials are never written to disk in plain text.'
            : 'Credentials stay in memory unless you ask to save them.'
        }
        onClose={close}
        width={480}
        footer={
          <>
            {canRemove ? (
              <Button
                variant="ghost"
                icon="trash"
                onClick={() => {
                  if (!editing) return;
                  void deleteProfile(editing.id).then(close).catch(() => undefined);
                }}
              >
                Delete
              </Button>
            ) : null}
            <span className="spacer" />
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" size="lg" loading={busy} icon="plug" onClick={onSubmit}>
              {editing ? 'Save & connect' : 'Connect'}
            </Button>
          </>
        }
      >
        {/* Starting from scratch is the exception: offer what is already saved first. */}
        {!editing ? (
          <section className="savedhosts">
            <header className="savedhosts__head">
              <span className="label">{t('conn.savedHosts')}</span>
              <span className="spacer" />
              <span className="savedhosts__count mono">{profiles.length}</span>
            </header>
            {profiles.length === 0 ? (
              <p className="savedhosts__empty">{t('conn.savedHostsNone')}</p>
            ) : (
              <>
                <ul className="savedhosts__list">
                  {profiles.map((profile) => {
                    const live = connections.find(
                      (c) =>
                        c.host === profile.host &&
                        c.port === profile.port &&
                        c.username === profile.username &&
                        c.status === 'authenticated',
                    );
                    const name = profile.label || `${profile.username}@${profile.host}`;
                    return (
                      <li key={profile.id}>
                        <button
                          type="button"
                          className="savedhosts__row"
                          title={t('conn.useSavedHost', { label: name })}
                          onClick={() =>
                            openConnectionDialog({
                              profile,
                              host: profile.host,
                              username: profile.username,
                              port: profile.port,
                            })
                          }
                        >
                          <span className={`host-row__dot host-row__dot--${profile.color ?? 'slate'}`}>
                            <StatusDot tone={live ? (profile.color ?? 'mint') : 'slate'} />
                          </span>
                          <span className="savedhosts__text">
                            <span className="savedhosts__label truncate">{name}</span>
                            <span className="savedhosts__sub mono truncate">
                              {profile.username}@{profile.host}:{profile.port}
                            </span>
                          </span>
                          {live ? <span className="savedhosts__live mono">{t('sidebar.online')}</span> : null}
                          <Icon name="chevron-right" size={13} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="savedhosts__hint">{t('conn.savedHostsHint')}</p>
              </>
            )}
          </section>
        ) : null}

        <div className="form-grid">
          {/* Naming comes first: a host you can recognise is worth more than one you
              have to read a user@host string to identify. */}
          <Field
            label={t('conn.name')}
            htmlFor="conn-label"
            hint={t('conn.nameHint')}
            className="form-grid__wide"
          >
            <TextInput
              id="conn-label"
              value={form.label}
              autoFocus
              spellCheck={false}
              placeholder={
                form.host ? `${form.username || 'user'}@${form.host}` : t('conn.namePlaceholder')
              }
              onChange={(event) => patch({ label: event.target.value })}
            />
          </Field>

          <div className="field form-grid__wide">
            <span className="field__label">{t('conn.colourTag')}</span>
            <div className="swatches">
              {HOST_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`swatch swatch--${color}${form.color === color ? ' is-active' : ''}`}
                  aria-label={color}
                  aria-pressed={form.color === color}
                  onClick={() => patch({ color })}
                />
              ))}
            </div>
          </div>

          <Field label="Host" htmlFor="conn-host">
            <TextInput
              id="conn-host"
              value={form.host}
              autoFocus
              mono
              spellCheck={false}
              placeholder="prod-web-01.internal"
              onChange={(event) => patch({ host: event.target.value })}
              onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
            />
          </Field>
          <Field label="Port" htmlFor="conn-port">
            <TextInput
              id="conn-port"
              value={form.port}
              mono
              inputMode="numeric"
              onChange={(event) => patch({ port: event.target.value.replace(/[^0-9]/g, '') })}
              onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
            />
          </Field>
        </div>

        <Field label="Username" htmlFor="conn-user">
          <TextInput
            id="conn-user"
            value={form.username}
            mono
            spellCheck={false}
            placeholder="deploy"
            onChange={(event) => patch({ username: event.target.value })}
            onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
          />
        </Field>

        {storedEntry ? (
          <div className="savedcred">
            <span className="savedcred__icon">
              <Icon name="shield" size={15} />
            </span>
            <div className="savedcred__body">
              <p className="savedcred__title">
                Credentials saved for {storedEntry.username}@{storedEntry.host}
              </p>
              <p className="savedcred__meta">
                {storedEntry.authMethod === 'password' ? 'Password' : 'Key passphrase'} В· updated{' '}
                {formatRelative(storedEntry.updatedAt)}
              </p>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                void forgetSecret(storedEntry.id).then(() => patch({ useSaved: false }))
              }
            >
              Forget
            </button>
          </div>
        ) : null}

        {storedEntry ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.useSaved}
              onChange={(event) => patch({ useSaved: event.target.checked })}
            />
            <span>Use the saved credentials</span>
          </label>
        ) : null}

        {form.useSaved ? null : (
          <>
            <div className="field">
              <span className="field__label">Authentication</span>
              <div className="field__control">
                <Segmented<AuthMethod>
                  value={form.authMethod}
                  ariaLabel="Authentication method"
                  onChange={(method) => patch({ authMethod: method })}
                  options={[
                    { value: 'password', label: 'Password' },
                    { value: 'privateKey', label: 'Private key' },
                    { value: 'agent', label: 'Agent' },
                  ]}
                />
              </div>
            </div>

            {form.authMethod === 'password' ? (
              <Field label="Password" htmlFor="conn-pass">
                <TextInput
                  id="conn-pass"
                  type="password"
                  value={form.password}
                  mono
                  autoComplete="off"
                  placeholder="••••••••••"
                  icon="lock"
                  onChange={(event) => patch({ password: event.target.value })}
                  onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
                />
              </Field>
            ) : form.authMethod === 'privateKey' ? (
              <>
                <Field label="Private key" htmlFor="conn-key">
                  <div className="keypick">
                    <TextInput
                      id="conn-key"
                      value={form.privateKeyPath}
                      mono
                      spellCheck={false}
                      placeholder="~/.ssh/id_ed25519"
                      icon="key"
                      onChange={(event) => patch({ privateKeyPath: event.target.value })}
                      onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
                    />
                    {keys.length ? (
                      <div className="keypick__list">
                        {keys.slice(0, 6).map((key) => (
                          <button
                            key={key.path}
                            type="button"
                            className={`keypick__item${form.privateKeyPath === key.path ? ' is-active' : ''}`}
                            onClick={() => patch({ privateKeyPath: key.path })}
                            title={key.path}
                          >
                            <Icon name="key" size={12} />
                            <span className="mono truncate">{key.name}</span>
                            <span className="keypick__type label">{key.type}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="field__hint">No keys found in {systemInfo?.sshDir ?? '~/.ssh'}.</p>
                    )}
                  </div>
                </Field>
                <Field label="Passphrase" htmlFor="conn-passphrase" hint="Leave empty when the key is not encrypted.">
                  <TextInput
                    id="conn-passphrase"
                type="password"
                value={form.passphrase}
                mono
                autoComplete="off"
                placeholder="optional"
                icon="lock"
                onChange={(event) => patch({ passphrase: event.target.value })}
                onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
              />
            </Field>
          </>
        ) : (
          <Field
            label="Agent socket"
            htmlFor="conn-agent"
            hint="Leave empty to use SSH_AUTH_SOCK / the default Pageant pipe."
          >
            <TextInput
              id="conn-agent"
              value={form.agentSocket}
              mono
              placeholder="optional"
              icon="plug"
              onChange={(event) => patch({ agentSocket: event.target.value })}
            />
          </Field>
            )}
          </>
        )}

        <button
          type="button"
          className={`disclosure${advanced ? ' is-open' : ''}`}
          onClick={() => setAdvanced((value) => !value)}
          aria-expanded={advanced}
        >
          <Icon name={advanced ? 'chevron-down' : 'chevron-right'} size={13} />
          <span>Advanced</span>
        </button>

        {advanced ? (
          <div className="advanced">
            {!editing ? (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={form.save}
                  onChange={(event) => patch({ save: event.target.checked })}
                />
                <span>{t('conn.saveHost')}</span>
              </label>
            ) : null}
          </div>
        ) : null}

        {!form.useSaved && form.authMethod !== 'agent' ? (
          <label className="checkbox checkbox--stacked">
            <input
              type="checkbox"
              checked={form.saveSecret}
              onChange={(event) => patch({ saveSecret: event.target.checked })}
            />
            <span>
              Save these credentials
              <span className="checkbox__hint">
                {secretStorage
                  ? secretStorage.label
                  : 'Encrypted before it is written to disk — never in plain text.'}
              </span>
            </span>
          </label>
        ) : null}

        {error ? (
          <p className="form-error">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </p>
        ) : null}
      </Modal>

      <HostKeyDialog
        challenge={challenge}
        busy={busy}
        onCancel={() => {
          setChallenge(null);
          setPending(null);
          setBusy(false);
        }}
        onTrust={() => {
          const request = pending ?? form;
          const current = challenge;
          if (!current) return;
          void submit(request, { fingerprint: current.fingerprint });
        }}
      />
    </>
  );
}

export function HostKeyDialog({
  challenge,
  busy,
  onCancel,
  onTrust,
}: {
  challenge: HostKeyChallenge | null;
  busy: boolean;
  onCancel: () => void;
  onTrust: () => void;
}) {
  if (!challenge) return null;
  return (
    <Modal
      open
      title="Unknown host key"
      subtitle={`${challenge.host}:${challenge.port}`}
      onClose={onCancel}
      width={520}
      footer={
        <>
          <span className="spacer" />
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} icon="shield" onClick={onTrust}>
            Trust and continue
          </Button>
        </>
      }
    >
      <p className="warn-line">
        <Icon name="alert" size={15} />
        <span>
          This host is not in your known hosts yet. Verify the fingerprint through a channel you
          already trust before continuing.
        </span>
      </p>

      <div className="fingerprint">
        <span className="label">SHA256 fingerprint</span>
        <code className="mono">{challenge.fingerprint}</code>
        {challenge.keyType ? (
          <span className="fingerprint__type mono">
            {challenge.keyType}
            {challenge.algorithm ? ` В· ${challenge.algorithm}` : ''}
          </span>
        ) : null}
      </div>

      <p className="dialog__text">
        Trusting writes the key to <code className="mono">{challenge.knownHostsPath || 'known_hosts'}</code>.
        If this key ever changes, SSH Explorer refuses the connection instead of trusting it silently.
      </p>
    </Modal>
  );
}
