import { useEffect, useMemo, useState } from 'react';
import type { AuthMethod, HostKeyChallenge, Protocol, SavedProfile } from '../../api/types';
import { HOST_COLORS } from '../../api/types';
import { ApiError } from '../../api/client';
import { nextHostColor, useConnectionStore } from '../../state/connectionStore';
import { useUiStore } from '../../state/uiStore';
import { formatRelative } from '../../lib/format';
import { Button, Field, Segmented, TextInput } from '../ui/Primitives';
import { Modal } from '../ui/Overlays';
import { Icon } from '../ui/Icon';
import { useT } from '../../i18n/useT';

interface FormState {
  protocol: Protocol;
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
  protocol: 'sftp',
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
    const username = form.username.trim() || (form.protocol === 'ftp' ? 'anonymous' : '');
    if (!host || !username) return undefined;
    return secrets.find(
      (entry) =>
        entry.host === host &&
        entry.port === (Number(form.port) || (form.protocol === 'ftp' ? 21 : 22)) &&
        entry.username === username,
    );
  }, [form.host, form.username, form.port, form.protocol, secrets]);

  useEffect(() => {
    if (!dialog.open) return;
    const protocol =
      dialog.protocol ??
      dialog.profile?.protocol ??
      (dialog.port === 21 || dialog.profile?.port === 21 ? 'ftp' : 'sftp');
    const host = dialog.host ?? dialog.profile?.host ?? '';
    const defaultPort = protocol === 'ftp' ? 21 : 22;
    const port = dialog.port ?? dialog.profile?.port ?? defaultPort;
    const username = dialog.username ?? dialog.profile?.username ?? '';
    const hasStored = useConnectionStore.getState().storedSecretFor(host, port, username) !== undefined;

    setForm({
      ...EMPTY,
      protocol,
      host,
      port: String(port),
      username,
      authMethod: protocol === 'ftp' ? 'password' : (dialog.profile?.authMethod ?? (systemInfo?.keys.length ? 'privateKey' : 'password')),
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

  const keys = systemInfo?.keys ?? [];
  const patch = (part: Partial<FormState>) => setForm((f) => ({ ...f, ...part }));

  /** The `auth` block for a form, or `undefined` to let the vault supply it. */
  const authFor = (current: FormState) => {
    if (current.useSaved) return undefined;
    if (current.protocol === 'ftp') {
      return { method: 'password' as const, password: current.password || '' };
    }
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
        protocol: current.protocol,
        host: current.host.trim(),
        port: Number(current.port) || (current.protocol === 'ftp' ? 21 : 22),
        username: current.protocol === 'ftp' && !current.username.trim() ? 'anonymous' : current.username.trim(),
        label: current.label.trim() || undefined,
        color: current.color,
        ...(authFor(current) !== undefined ? { auth: authFor(current) } : {}),
        ...(current.useSaved ? { useStoredSecret: true } : {}),
        ...(current.saveSecret && !current.useSaved ? { saveSecret: true } : {}),
        ...(trust ? { trustHostKey: true, hostKeyFingerprint: trust.fingerprint } : {}),
      });
      const { connection } = outcome;

      if (editing) {
        await updateProfile(editing.id, {
          protocol: current.protocol,
          label: connection.label,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          authMethod: connection.authMethod,
          privateKeyPath:
            current.protocol !== 'ftp' && current.authMethod === 'privateKey' ? current.privateKeyPath : undefined,
          color: current.color,
        }).catch(() => undefined);
      } else if (current.save) {
        await useConnectionStore
          .getState()
          .saveProfile({
            protocol: current.protocol,
            label: connection.label,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            authMethod: connection.authMethod,
            privateKeyPath:
              current.protocol !== 'ftp' && current.authMethod === 'privateKey' ? current.privateKeyPath : undefined,
            color: current.color,
          })
          .catch(() => undefined);
      }

      pushToast({
        level: 'success',
        title: t('conn.connectedTo', { label: connection.label }),
        detail: connection.serverInfo
          ? `${connection.serverInfo.platform} ${connection.serverInfo.release} · ${connection.serverInfo.arch}`
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
          t('conn.hostKeyChanged', {
            path: String(caught.details?.knownHostsPath ?? 'known_hosts'),
          }),
        );
      } else if (caught instanceof ApiError && caught.code === 'AUTH_FAILED') {
        setError(t('conn.authFailed'));
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
    if (!form.host.trim()) return setError(t('conn.hostRequired'));
    if (form.protocol !== 'ftp' && !form.username.trim()) return setError(t('conn.userRequired'));
    if (!form.useSaved) {
      if (form.protocol === 'ftp') {
        // FTP allows anonymous without password
      } else {
        if (form.authMethod === 'password' && !form.password) {
          return setError(t('conn.passwordRequired'));
        }
        if (form.authMethod === 'privateKey' && !form.privateKeyPath) {
          return setError(t('conn.keyRequired'));
        }
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
        title={editing ? t('conn.edit') : t('conn.new')}
        subtitle={
          editing
            ? secretStorage
              ? secretStorage.kind === 'os-keychain'
                ? t('conn.subtitleEditKeychain')
                : t('conn.subtitleEditLocal')
              : t('conn.subtitleEditNone')
            : t('conn.subtitleNew')
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
                {t('common.delete')}
              </Button>
            ) : null}
            <span className="spacer" />
            <Button variant="ghost" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="lg" loading={busy} icon="plug" onClick={onSubmit}>
              {editing ? t('conn.saveAndConnect') : t('conn.connect')}
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <div className="field form-grid__wide">
            <span className="field__label">{t('conn.protocol')}</span>
            <Segmented
              value={form.protocol}
              onChange={(val) => {
                const proto = val as 'sftp' | 'ftp';
                patch({
                  protocol: proto,
                  port: proto === 'ftp' ? (form.port === '22' ? '21' : form.port) : (form.port === '21' ? '22' : form.port),
                  authMethod: proto === 'ftp' ? 'password' : form.authMethod,
                });
              }}
              options={[
                { value: 'sftp', label: t('conn.sftp') },
                { value: 'ftp', label: t('conn.ftp') },
              ]}
            />
          </div>

          <Field
            label={t('conn.name')}
            htmlFor="conn-label"
            hint={t('conn.nameHint')}
            className="form-grid__wide"
          >
            <TextInput
              id="conn-label"
              value={form.label}
              spellCheck={false}
              placeholder={
                form.host ? `${form.username || (form.protocol === 'ftp' ? 'anonymous' : 'user')}@${form.host}` : t('conn.namePlaceholder')
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

          <Field label={t('conn.host')} htmlFor="conn-host">
            <TextInput
              id="conn-host"
              value={form.host}
              autoFocus
              mono
              spellCheck={false}
              placeholder={form.protocol === 'ftp' ? 'ftp.example.com' : 'prod-web-01.internal'}
              onChange={(event) => patch({ host: event.target.value })}
              onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
            />
          </Field>
          <Field label={t('conn.port')} htmlFor="conn-port">
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

        <Field label={t('conn.username')} htmlFor="conn-user">
          <TextInput
            id="conn-user"
            value={form.username}
            mono
            spellCheck={false}
            placeholder={form.protocol === 'ftp' ? 'anonymous' : 'deploy'}
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
                {t('conn.savedFor', { user: storedEntry.username, host: storedEntry.host })}
              </p>
              <p className="savedcred__meta">
                {t('conn.savedMeta', {
                  method: storedEntry.authMethod === 'password' ? t('conn.password') : t('conn.passphrase'),
                  when: formatRelative(storedEntry.updatedAt),
                })}
              </p>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                void forgetSecret(storedEntry.id).then(() => patch({ useSaved: false }))
              }
            >
              {t('conn.forget')}
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
            <span>{t('conn.useSaved')}</span>
          </label>
        ) : null}

        {form.protocol === 'ftp' ? (
          !form.useSaved ? (
            <Field
              label={t('conn.password')}
              htmlFor="conn-pass"
              hint={t('conn.ftpPasswordHint')}
            >
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
          ) : null
        ) : (
          !form.useSaved ? (
            <>
              <div className="field">
                <span className="field__label">{t('conn.authentication')}</span>
                <div className="field__control">
                  <Segmented<AuthMethod>
                    value={form.authMethod}
                    ariaLabel={t('conn.authentication')}
                    onChange={(method) => patch({ authMethod: method })}
                    options={[
                      { value: 'password', label: t('conn.password') },
                      { value: 'privateKey', label: t('conn.privateKey') },
                      { value: 'agent', label: t('conn.agent') },
                    ]}
                  />
                </div>
              </div>

              {form.authMethod === 'password' ? (
                <Field label={t('conn.password')} htmlFor="conn-pass">
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
                  <Field label={t('conn.privateKey')} htmlFor="conn-key">
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
                        <p className="field__hint">{t('conn.noKeys', { dir: systemInfo?.sshDir ?? '~/.ssh' })}</p>
                      )}
                    </div>
                  </Field>
                  <Field label={t('conn.passphrase')} htmlFor="conn-passphrase" hint={t('conn.passphraseHint')}>
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
                  label={t('conn.agentSocket')}
                  htmlFor="conn-agent"
                  hint={t('conn.agentSocketHint')}
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
          ) : null
        )}

        <button
          type="button"
          className={`disclosure${advanced ? ' is-open' : ''}`}
          onClick={() => setAdvanced((value) => !value)}
          aria-expanded={advanced}
        >
          <Icon name={advanced ? 'chevron-down' : 'chevron-right'} size={13} />
          <span>{t('conn.advanced')}</span>
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

        {!form.useSaved && (form.protocol === 'ftp' || form.authMethod !== 'agent') ? (
          <label className="checkbox checkbox--stacked">
            <input
              type="checkbox"
              checked={form.saveSecret}
              onChange={(event) => patch({ saveSecret: event.target.checked })}
            />
            <span>
              {t('conn.saveCredentials')}
              <span className="checkbox__hint">
                {secretStorage
                  ? secretStorage.label
                  : t('conn.credentialsSavedNote')}
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
  const { t } = useT();
  if (!challenge) return null;
  return (
    <Modal
      open
      title={t('hostkey.title')}
      subtitle={`${challenge.host}:${challenge.port}`}
      onClose={onCancel}
      width={520}
      footer={
        <>
          <span className="spacer" />
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} icon="shield" onClick={onTrust}>
            {t('hostkey.trust')}
          </Button>
        </>
      }
    >
      <p className="warn-line">
        <Icon name="alert" size={15} />
        <span>{t('hostkey.warning')}</span>
      </p>

      <div className="fingerprint">
        <span className="label">{t('hostkey.fingerprint')}</span>
        <code className="mono">{challenge.fingerprint}</code>
        {challenge.keyType ? (
          <span className="fingerprint__type mono">
            {challenge.keyType}
            {challenge.algorithm ? ` · ${challenge.algorithm}` : ''}
          </span>
        ) : null}
      </div>

      <p className="dialog__text">
        {t('hostkey.trustWrites', { path: challenge.knownHostsPath || 'known_hosts' })}{' '}
        {t('hostkey.trustWritesTail')}
      </p>
    </Modal>
  );
}
