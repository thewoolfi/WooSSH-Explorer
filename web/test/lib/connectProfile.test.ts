import { describe, expect, test } from 'vitest';

import type { SavedProfile } from '../../src/api/types';
import { planProfileConnect, secretIdFor } from '../../src/lib/connectProfile';

type ProfileInput = Parameters<typeof planProfileConnect>[0]['profile'];

const base: ProfileInput = {
  id: 'p1',
  label: 'prod-web',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  color: 'mint',
  authMethod: 'password',
  privateKeyPath: undefined,
};

describe('planProfileConnect', () => {
  test('uses the stored credential without ever reading it', () => {
    // The password must not travel through the renderer: the request says "use the vault".
    const plan = planProfileConnect({ profile: base, hasStoredSecret: true });
    expect(plan.kind).toBe('connect');
    if (plan.kind !== 'connect') return;
    expect(plan.request.useStoredSecret).toBe(true);
    expect(plan.request.auth).toBeUndefined();
    expect(plan.request.profileId).toBe('p1');
  });

  test('asks for a password rather than sending an empty one', () => {
    // Dialling with no credential would come back as an auth failure and look like a
    // wrong password, which is a worse answer than being asked.
    const plan = planProfileConnect({ profile: base, hasStoredSecret: false });
    expect(plan).toEqual({ kind: 'needs-dialog', reason: 'no-stored-credential' });
  });

  test('a key file connects without any secret', () => {
    const plan = planProfileConnect({
      profile: { ...base, authMethod: 'privateKey', privateKeyPath: '/home/me/.ssh/id_ed25519' },
      hasStoredSecret: false,
    });
    expect(plan.kind).toBe('connect');
    if (plan.kind !== 'connect') return;
    expect(plan.request.auth).toEqual({
      method: 'privateKey',
      privateKeyPath: '/home/me/.ssh/id_ed25519',
    });
  });

  test('a key profile with no key path is sent to the dialog', () => {
    const plan = planProfileConnect({
      profile: { ...base, authMethod: 'privateKey', privateKeyPath: '' },
      hasStoredSecret: false,
    });
    expect(plan).toEqual({ kind: 'needs-dialog', reason: 'no-key' });
  });

  test('an agent profile connects without a secret', () => {
    const plan = planProfileConnect({ profile: { ...base, authMethod: 'agent' }, hasStoredSecret: false });
    expect(plan.kind).toBe('connect');
  });
});

describe('secretIdFor', () => {
  const secrets = [
    { id: 's1', host: 'a.example', port: 22, username: 'root', authMethod: 'password' as const, updatedAt: 0 },
    { id: 's2', host: 'a.example', port: 2222, username: 'root', authMethod: 'password' as const, updatedAt: 0 },
  ];

  test('matches the port as well as the host', () => {
    // Same host on two ports is two different credentials.
    expect(secretIdFor(secrets, 'a.example', 2222, 'root')).toBe('s2');
    expect(secretIdFor(secrets, 'a.example', 22, 'root')).toBe('s1');
  });

  test('matches the user as well as the host', () => {
    expect(secretIdFor(secrets, 'a.example', 22, 'deploy')).toBeNull();
  });

  test('returns null when nothing is stored', () => {
    expect(secretIdFor([], 'a.example', 22, 'root')).toBeNull();
  });
});
