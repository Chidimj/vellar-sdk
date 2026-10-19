// Core domain types for the Vellar wallet SDK. Self-contained — the SDK carries
// its own copy so it installs with no workspace/monorepo dependency.

export type Network = "testnet" | "mainnet";

// --- Passkey wallet ---

export interface WalletSession {
  accountId: string;
  network: Network;
  connected: boolean;
  authMethod: "passkey";
  createdAt: string;
  lastActiveAt: string;
  /** Server-side session record id — lets a UI mark "this device". */
  serverSessionId?: string;
  /**
   * The passkey's base64url credential id: lets a fresh page resume the kit
   * connection without a WebAuthn prompt (connectWallet({ keyId }) skips the
   * discovery ceremony). Public data.
   */
  keyId?: string;
  /**
   * Persisted-shape version, stamped by `SessionState.start`. Absent on
   * sessions saved before versioning (treated as version 1). `restore()`
   * rejects anything newer than `SESSION_SCHEMA_VERSION` with
   * `SessionSchemaTooNewError` instead of parsing it as the current shape.
   */
  schemaVersion?: number;
}

export interface CreateWalletInput {
  /**
   * Display name for the passkey. Surrounding whitespace (including Unicode
   * spaces) is trimmed; missing or blank falls back to "Vellar user". Control
   * characters (Unicode category Cc, plus U+2028/U+2029) are rejected with
   * `InvalidUsernameError` before the passkey ceremony starts.
   */
  username?: string;
  network: Network;
}

export interface SignTransactionInput {
  xdr: string;
  network: Network;
}

// --- Smart Account Policy Builder ---

export interface PolicyDefinition {
  version: string;
  type: string;
  owners: string[];
  threshold?: number;
  spendingLimits?: {
    dailyXlm?: string;
    perTxXlm?: string;
  };
  allowlistedContracts?: string[];
  timelocks?: {
    adminActionDelaySeconds?: number;
  };
}
