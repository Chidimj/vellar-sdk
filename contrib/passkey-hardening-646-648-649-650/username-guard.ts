import type { PasskeyKitLike } from "../../src/passkeykit-connector";

/** The username cannot be used as a passkey display name (#648). */
export class InvalidUsernameError extends Error {
  constructor(reason = "username must not contain control characters") {
    super(reason);
    this.name = "InvalidUsernameError";
  }
}

export const DEFAULT_USERNAME = "Vellar user";

// Control characters (Unicode Cc) plus line/paragraph separators: not valid in
// a WebAuthn user.name and a vector for spoofing the platform passkey prompt.
const INVALID_USERNAME_CHARS = /[\p{Cc}\u2028\u2029]/u;

/**
 * Accepted username format for `create({ username })`:
 * - surrounding whitespace, including Unicode spaces, is trimmed;
 * - missing, empty or whitespace-only becomes {@link DEFAULT_USERNAME};
 * - control characters (Unicode category Cc, U+2028, U+2029) throw
 *   {@link InvalidUsernameError}.
 * Trimming happens first, so leading/trailing tabs or newlines are removed
 * rather than rejected; a control character inside the name is rejected.
 * Applied before the passkey ceremony starts.
 */
export function normalizeUsername(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (INVALID_USERNAME_CHARS.test(trimmed)) throw new InvalidUsernameError();
  return trimmed || DEFAULT_USERNAME;
}

/**
 * Wraps a PasskeyKit-like object so `createWallet` validates and normalizes the
 * username (see {@link normalizeUsername}) before registration is invoked.
 * Pass the result as `kit` to `createVellarWallet` / `createPasskeyKitConnector`.
 */
export function withUsernameValidation(kit: PasskeyKitLike): PasskeyKitLike {
  return {
    createWallet: (app, user) => kit.createWallet(app, normalizeUsername(user)),
    connectWallet: (opts) => kit.connectWallet(opts),
    sign: (tx) => kit.sign(tx),
    get rpId() {
      return kit.rpId;
    },
    get wallet() {
      return kit.wallet;
    },
  };
}
