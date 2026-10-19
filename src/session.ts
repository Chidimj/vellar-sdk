import { createStore, type StoreApi } from "zustand/vanilla";
import type { WalletSession } from "./types";

// Session persistence seam (idea.md §6.1 WalletSessionStore). The store is a
// vanilla zustand store so the web app (React) and the extension (background
// worker + popup) can share it; each surface supplies its own storage adapter
// (localStorage vs browser.storage), keeping the logic itself DRY.

export interface SessionStorageAdapter {
  load(): Promise<WalletSession | null>;
  save(session: WalletSession): Promise<void>;
  clear(): Promise<void>;
}

/** Current persisted-session shape. Bump when `WalletSession`'s stored shape changes incompatibly. */
export const SESSION_SCHEMA_VERSION = 1;

/**
 * A persisted session was written by a newer SDK whose shape this version does
 * not understand. Distinct from corruption: the stored data is intact and must
 * not be erased, so a newer client (or a downgrade-then-upgrade) can still use it.
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

/** Throws SessionSchemaTooNewError if `value` carries a valid but unsupported-future schemaVersion. */
export function assertSessionSchemaSupported(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && Number.isInteger(version) && version > SESSION_SCHEMA_VERSION) {
    throw new SessionSchemaTooNewError(version);
  }
}

export type SessionStatus = "loading" | "connected" | "disconnected";

export interface SessionState {
  session: WalletSession | null;
  status: SessionStatus;
  /** Why the last restore() left the session disconnected for a reason the app can act on (e.g. a newer schema); null otherwise. */
  restoreError: Error | null;
  /** Begin a session (after wallet create/connect) and persist it. */
  start(session: WalletSession): Promise<void>;
  /** Update lastActiveAt on user activity and persist. No-op when disconnected. */
  touch(now?: Date): Promise<void>;
  /** End the session and clear persisted state. */
  end(): Promise<void>;
  /** Restore a persisted session on startup. Corrupt/unreadable storage means disconnected, never a crash. */
  restore(): Promise<void>;
  /**
   * Graceful teardown for long-lived consumers (React unmount, extension
   * shutdown): clears any internal timers (e.g. the optional refresh polling)
   * and releases listers so no dangling references keep the session alive.
   * Safe to call multiple times and after disconnection. Does not mutate the
   * session or storage — pairing with `end()` first is up to the caller.
   */
  dispose(): void;
}

export type SessionStore = StoreApi<SessionState>;

export interface CreateSessionStoreOptions {
  /**
   * Optional background "refresh polling": while connected, `touch()` is called
   * every `refreshIntervalMs` to keep `lastActiveAt` fresh. Omit (the default)
   * to disable periodic polling. Any in-progress polling is stopped by
   * `dispose()`.
   */
  refreshIntervalMs?: number;
}

export function isWalletSession(value: unknown): value is WalletSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accountId === "string" &&
    v.accountId.length > 0 &&
    (v.network === "testnet" || v.network === "mainnet") &&
    typeof v.connected === "boolean" &&
    v.authMethod === "passkey" &&
    (v.schemaVersion === undefined ||
      (typeof v.schemaVersion === "number" && Number.isInteger(v.schemaVersion) && v.schemaVersion >= 1)) &&
    typeof v.createdAt === "string" &&
    typeof v.lastActiveAt === "string"
  );
}

export function createSessionStore(
  storage: SessionStorageAdapter,
  options: CreateSessionStoreOptions = {},
): SessionStore {
  // Long-lived resources owned by the store: the optional refresh-polling
  // interval plus a disposed latch so a torn-down store never schedules new
  // work. `dispose()` clears both; nothing in the store keeps a reference to
  // them afterwards.
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function startRefresh(): void {
    if (disposed) return;
    if (timer !== null) return;
    if (!options.refreshIntervalMs || options.refreshIntervalMs <= 0) return;
    timer = setInterval(() => {
      // Refresh is a fire-and-forget touch; storage failures are non-fatal here
      // (the user-facing start()/touch() still surface them).
      if (disposed) return;
      void store.getState().touch();
    }, options.refreshIntervalMs);
  }

  function stopRefresh(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  let store: SessionStore = null as never;

  store = createStore<SessionState>((set, get) => ({
    session: null,
    status: "loading",
    restoreError: null,

    async start(session) {
      const stamped: WalletSession = { ...session, schemaVersion: SESSION_SCHEMA_VERSION };
      await storage.save(stamped);
      set({ session: stamped, status: "connected", restoreError: null });
      // Begin periodic refresh only once connected (and only if configured).
      startRefresh();
    },

    async touch(now = new Date()) {
      const { session } = get();
      if (!session) return;
      const updated: WalletSession = { ...session, lastActiveAt: now.toISOString() };
      await storage.save(updated);
      set({ session: updated });
    },

    async end() {
      await storage.clear();
      // Disconnect stops any in-flight refresh polling.
      stopRefresh();
      set({ session: null, status: "disconnected" });
    },

    async restore() {
      try {
        const stored = await storage.load();
        // Version gate runs before the shape check so a future-schema blob is
        // never mistaken for (or parsed as) the current shape.
        assertSessionSchemaSupported(stored);
        if (stored && isWalletSession(stored)) {
          set({ session: stored, status: "connected", restoreError: null });
          startRefresh();
        } else {
          set({ session: null, status: "disconnected", restoreError: null });
        }
      } catch (err) {
        if (err instanceof SessionSchemaTooNewError) {
          // Keep the newer blob in storage; just report why we are disconnected.
          set({ session: null, status: "disconnected", restoreError: err });
          return;
        }
        // Unreadable storage must not brick the app on startup.
        set({ session: null, status: "disconnected", restoreError: null });
      }
    },

    dispose() {
      disposed = true;
      stopRefresh();
    },
  }));

  return store;
}

/** Storage-backed adapter for web (pass window.localStorage) or any Storage-like object. */
export function createWebStorageAdapter(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key = "vellar.session",
): SessionStorageAdapter {
  return {
    async load() {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      assertSessionSchemaSupported(parsed);
      return isWalletSession(parsed) ? parsed : null;
    },
    async save(session) {
      storage.setItem(key, JSON.stringify(session));
    },
    async clear() {
      storage.removeItem(key);
    },
  };
}

/** In-memory adapter for tests and ephemeral contexts. */
export function createMemoryStorageAdapter(): SessionStorageAdapter {
  let stored: WalletSession | null = null;
  return {
    async load() {
      return stored;
    },
    async save(session) {
      stored = session;
    },
    async clear() {
      stored = null;
    },
  };
}
