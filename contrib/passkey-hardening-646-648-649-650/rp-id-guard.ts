import type { PasskeyKitLike } from "../../src/passkeykit-connector";

/** A passkey assertion/registration was scoped to a different WebAuthn RP ID than configured (#646). */
export class PasskeyRpIdMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string | undefined,
  ) {
    super(
      actual === undefined
        ? `Passkey RP ID is configured as "${expected}" but the kit did not report one, so it cannot be verified`
        : `Passkey RP ID mismatch: configured "${expected}" but the ceremony used "${actual}"`,
    );
    this.name = "PasskeyRpIdMismatchError";
  }
}

/**
 * Wraps a PasskeyKit-like object so every ceremony is bound to `expectedRpId`
 * (the domain passkeys are scoped to). Pass the result as `kit` to
 * `createVellarWallet` / `createPasskeyKitConnector`.
 *
 * Expected RP ID validation:
 * - Before any create, connect or sign, the kit's own `rpId` (when it reports
 *   one) must equal `expectedRpId`; otherwise nothing is prompted or signed.
 * - After create/connect, the RP ID reported with the result (falling back to
 *   the kit's `rpId`) must equal `expectedRpId`. The wrapper throws before the
 *   result reaches the connector, so the backend never receives a deployment
 *   or lookup for a credential scoped to another origin.
 * - Once an RP ID is configured, a ceremony result that reports no RP ID at
 *   all fails closed: an unverifiable ceremony is treated as a mismatch.
 *
 * This blocks cross-origin credential confusion. See "Threat model" in
 * website/content/docs/architecture/threat-model.md; the chain still decides
 * what a signature can do, so this narrows which credentials the client
 * accepts and does not replace on-chain signer verification.
 */
export function withRpIdGuard(kit: PasskeyKitLike, expectedRpId: string): PasskeyKitLike {
  function assertKitRpId(): void {
    if (kit.rpId !== undefined && kit.rpId !== expectedRpId) {
      throw new PasskeyRpIdMismatchError(expectedRpId, kit.rpId);
    }
  }

  function assertResultRpId(reported: string | undefined): void {
    const actual = reported ?? kit.rpId;
    if (actual !== expectedRpId) throw new PasskeyRpIdMismatchError(expectedRpId, actual);
  }

  return {
    async createWallet(app, user) {
      assertKitRpId();
      const result = await kit.createWallet(app, user);
      assertResultRpId(result.rpId);
      return result;
    },
    async connectWallet(opts) {
      assertKitRpId();
      const result = await kit.connectWallet(opts);
      assertResultRpId(result.rpId);
      return result;
    },
    async sign(tx) {
      assertKitRpId();
      return kit.sign(tx);
    },
    get rpId() {
      return kit.rpId;
    },
    get wallet() {
      return kit.wallet;
    },
  };
}
