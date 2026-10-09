/**
 * The pieces of "connect to this saved host" that the sidebar, the command palette and
 * the tab strip all need, so a double-click behaves like the Connect menu item and like
 * the dialog — instead of each one inventing its own path to the same API call.
 */
import type { ConnectRequest, SavedProfile, VaultSecretEntry } from '../api/types';

/** Which stored secret belongs to a host, as the API names it. */
export function secretIdFor(
  secrets: readonly VaultSecretEntry[],
  host: string,
  port: number,
  username: string,
): string | null {
  const match = secrets.find(
    (entry) => entry.host === host && entry.port === port && entry.username === username,
  );
  return match?.id ?? null;
}

export type ConnectPlan =
  | { kind: 'connect'; request: ConnectRequest }
  | { kind: 'needs-dialog'; reason: 'no-stored-credential' | 'no-key' };

/**
 * Builds the request for a saved host.
 *
 * The credential itself is never read here: the request says `useStoredSecret` and the
 * server decrypts it, so a password never has to travel through the renderer at all.
 *
 * Returns `needs-dialog` rather than sending a request that cannot succeed — an empty
 * password would come back as an authentication failure and look like a wrong password,
 * which is a worse answer than being asked for one.
 */
export function planProfileConnect(input: {
  profile: Pick<
    SavedProfile,
    'id' | 'label' | 'host' | 'port' | 'username' | 'authMethod' | 'privateKeyPath' | 'color'
  >;
  /** Whether the vault holds a credential for this host. */
  hasStoredSecret: boolean;
}): ConnectPlan {
  const { profile, hasStoredSecret } = input;
  const request: ConnectRequest = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    label: profile.label,
    color: profile.color,
    profileId: profile.id,
    useStoredSecret: true,
  };

  if (hasStoredSecret) return { kind: 'connect', request };

  // A key file needs no secret to be usable; anything else does.
  if (profile.authMethod === 'agent') return { kind: 'connect', request };
  if (profile.authMethod === 'privateKey') {
    const keyPath = profile.privateKeyPath;
    if (keyPath === null || keyPath === undefined || keyPath === '') {
      return { kind: 'needs-dialog', reason: 'no-key' };
    }
    return { kind: 'connect', request: { ...request, auth: { method: 'privateKey', privateKeyPath: keyPath } } };
  }

  return { kind: 'needs-dialog', reason: 'no-stored-credential' };
}
