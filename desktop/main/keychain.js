// The OS keychain through Electron safeStorage: Keychain on macOS, DPAPI on Windows, the Secret Service (GNOME
// Keyring, KWallet) on Linux. Seals the ChatGPT token set before it is written to disk.
import { safeStorage } from 'electron';

class KeychainError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 503;
    this.code = 'keychain_unavailable';
  }
}

export function createKeychain() {
  let plainText = false;
  /**
   * Linux with no keyring (no Secret Service, or a minimal desktop): Electron's own fixed key instead, so the sign-in
   * still works. The file stays readable by this user only (0600), which is what OpenAI asks of credential files; the
   * Desktop settings page says the protection is basic. Never on Windows or macOS.
   */
  const ready = () => {
    if (safeStorage.isEncryptionAvailable()) return true;
    if (process.platform !== 'linux') return false;
    if (!plainText) {
      try {
        safeStorage.setUsePlainTextEncryption(true);
        plainText = true;
      } catch {
        return false;
      }
    }
    return true;
  };
  const backend = () => {
    if (process.platform === 'darwin') return 'keychain';
    if (process.platform === 'win32') return 'dpapi';
    try {
      return safeStorage.getSelectedStorageBackend();
    } catch {
      return 'unknown';
    }
  };
  return {
    /** what protects the sign-in here; `weak` = Linux with no keyring (a fixed key, like a plain file) */
    info() {
      const available = ready();
      const b = backend();
      return { available, backend: b, weak: !available || plainText || b === 'basic_text' || b === 'unknown' };
    },
    seal(text) {
      if (!ready()) throw new KeychainError('This computer has no keychain to keep the ChatGPT sign-in safe.');
      return safeStorage.encryptString(text).toString('base64');
    },
    open(sealed) {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
    },
  };
}
