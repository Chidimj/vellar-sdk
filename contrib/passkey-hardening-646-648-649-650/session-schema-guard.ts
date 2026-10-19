import type { SessionState, SessionStorageAdapter, SessionStore } from "../../src/session";
import { isWalletSession } from "../../src/session";
import type { WalletSession } from "../../src/types";

/**
 * Current persisted-session shape. Coordinated with #220, which introduces the
 * schema version field: the field is `schemaVersion`, an integer >= 1, and a
 * session saved before versioning (no field) is treated as version 1. Bump
 * this when the stored shape changes incompatibly.
 */
export const SESSION_SCHEMA_VERSION = 1;

/** A persisted session carries the schemaVersion field (#649). */
export type VersionedWalletSession = WalletSession & { schemaVersion?: number };

/**
 * A persisted session was written by a newer SDK whose shape this version does
 * not understand. Distinct from corruption: the stored data is intact and must
 * not be erased, so a newer client can still use it.
 */
export class SessionSchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number = SESSION_SCHEMA_VERSION,
  ) {
    super(
      `Stored session uses schema version ${found}, newer than the supported version ${supported}. ` +
        "Update vellar-sdk to restore it; the stored session was left untouched.",
    );
    this.name = "SessionSchemaTooNewError";
  }
}

/**
 * Throws SessionSchemaTooNewError when `value` carries an integer
 * `schemaVersion` above the supported one. Runs on the raw parsed value,
 * before any shape check, so a future blob is never parsed as the current
 * shape. A non-integer or non-positive version is not "newer": it falls
 * through to the normal shape check and is treated as corrupted.
 */
export function assertSessionSchemaSupported(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && Number.isInteger(version) && version > SESSION_SCHEMA_VERSION) {
    throw new SessionSchemaTooNewError(version);
  }
}

function hasValidVersion(value: VersionedWalletSession): boolean {
  const v = value.schemaVersion;
  return v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 1);
}

/**
 * Web-storage adapter (pass window.localStorage) that stamps `schemaVersion`
 * on save and enforces the version gate on load. On a newer schema, `load()`
 * throws SessionSchemaTooNewError WITHOUT touching storage; corrupted JSON or a
 * wrong shape still loads as `null`/throws a parse error as in the core adapter.
 */
export function createVersionedWebStorageAdapter(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key = "vellar.session",
): SessionStorageAdapter {
  return {
    async load() {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      assertSessionSchemaSupported(parsed);
      return isWalletSession(parsed) && hasValidVersion(parsed) ? parsed : null;
    },
    async save(session) {
      const stamped: VersionedWalletSession = { ...session, schemaVersion: SESSION_SCHEMA_VERSION };
      storage.setItem(key, JSON.stringify(stamped));
    },
    async clear() {
      storage.removeItem(key);
    },
  };
}

export type RestoreOutcome =
  | { status: "connected" }
  | { status: "disconnected"; reason: "none" | "corrupted" }
  | { status: "disconnected"; reason: "schema_too_new"; error: SessionSchemaTooNewError };

/**
 * Restores a session through `adapter` and reports why it did or did not
 * connect, so a future-schema session is distinguishable from a corrupted or
 * missing one. The store is only ever fed a session this version understands.
 * A newer-schema blob leaves the store disconnected and storage untouched.
 */
export async function restoreWithSchemaCheck(
  store: SessionStore,
  adapter: SessionStorageAdapter,
): Promise<RestoreOutcome> {
  let stored: WalletSession | null;
  try {
    stored = await adapter.load();
    // In-memory adapters hand back the object as-is; gate it here too.
    assertSessionSchemaSupported(stored);
  } catch (err) {
    if (err instanceof SessionSchemaTooNewError) {
      await markDisconnected(store);
      return { status: "disconnected", reason: "schema_too_new", error: err };
    }
    await markDisconnected(store);
    return { status: "disconnected", reason: "corrupted" };
  }
  if (stored === null) {
    await markDisconnected(store);
    return { status: "disconnected", reason: "none" };
  }
  await store.getState().restore();
  return store.getState().status === "connected"
    ? { status: "connected" }
    : { status: "disconnected", reason: "corrupted" };
}

// restore() against an adapter that yields nothing leaves the store in the
// plain "disconnected" state without ever clearing storage.
async function markDisconnected(store: SessionStore): Promise<void> {
  store.setState({ session: null, status: "disconnected" } as Partial<SessionState>);
}
