import { safeStorage } from 'electron';
import type { SecretBox } from '@ssh-explorer/server-runtime';

/**
 * Seals saved credentials with the operating system's own secret storage:
 * DPAPI on Windows, the Keychain on macOS, libsecret on Linux.
 *
 * The encryption key never leaves the OS keychain and the ciphertext is bound to
 * the logged-in user account, which is the strongest option available to a
 * desktop app. When the platform cannot provide it (`isEncryptionAvailable()`
 * false — some Linux desktops with no keyring daemon), this box is not injected
 * at all and the server falls back to its local-key box, which the UI labels
 * honestly.
 */
export class SafeStorageSecretBox implements SecretBox {
  readonly kind = 'os-keychain' as const;
  readonly label =
    'Sealed by the operating system keychain (DPAPI on Windows) — bound to your user account';

  async encrypt(plaintext: string): Promise<string> {
    return safeStorage.encryptString(plaintext).toString('base64');
  }

  async decrypt(payload: string): Promise<string> {
    return safeStorage.decryptString(Buffer.from(payload, 'base64'));
  }
}

/** Returns a usable box, or `undefined` so the server keeps its local-key fallback. */
export function resolveSecretBox(): SafeStorageSecretBox | undefined {
  try {
    if (safeStorage.isEncryptionAvailable()) return new SafeStorageSecretBox();
  } catch {
    /* fall through to the server default */
  }
  return undefined;
}
