import { describe, expect, it, vi } from "vitest";
import { createSessionStore } from "../../src/session";
import type { WalletSession } from "../../src/types";
import {
  assertSessionSchemaSupported,
  createVersionedWebStorageAdapter,
  restoreWithSchemaCheck,
  SESSION_SCHEMA_VERSION,
  SessionSchemaTooNewError,
} from "./session-schema-guard";

const session: WalletSession = {
  accountId: "CACCOUNT123",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-07-16T10:00:00.000Z",
  lastActiveAt: "2026-07-16T10:00:00.000Z",
};

function fakeStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_k: string, v: string) => {
      value = v;
    }),
    removeItem: vi.fn(() => {
      value = null;
    }),
  };
}

function setup(initial: string | null = null) {
  const storage = fakeStorage(initial);
  const adapter = createVersionedWebStorageAdapter(storage);
  const store = createSessionStore(adapter);
  return { storage, adapter, store };
}

describe("session schema version guard (#649)", () => {
  it("stamps the current schemaVersion when a session is started", async () => {
    const { storage, store } = setup();
    await store.getState().start(session);
    const saved = JSON.parse(storage.setItem.mock.calls[0][1]);
    expect(saved.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
  });

  it("round-trips a current-version session (happy path)", async () => {
    const { storage, adapter, store } = setup();
    await store.getState().start(session);

    const second = createSessionStore(createVersionedWebStorageAdapter(storage));
    const outcome = await restoreWithSchemaCheck(second, adapter);
    expect(outcome).toEqual({ status: "connected" });
    expect(second.getState().session?.accountId).toBe("CACCOUNT123");
  });

  it("restores an unversioned (pre-#220) session as version 1", async () => {
    const { store, adapter } = setup(JSON.stringify(session));
    expect(await restoreWithSchemaCheck(store, adapter)).toEqual({ status: "connected" });
  });

  it("rejects a session stamped with a higher version as SessionSchemaTooNewError", async () => {
    const future = { ...session, schemaVersion: SESSION_SCHEMA_VERSION + 1 };
    const { store, adapter } = setup(JSON.stringify(future));

    const outcome = await restoreWithSchemaCheck(store, adapter);
    expect(outcome.status).toBe("disconnected");
    if (outcome.status !== "disconnected" || outcome.reason !== "schema_too_new") {
      throw new Error("expected schema_too_new");
    }
    expect(outcome.error).toBeInstanceOf(SessionSchemaTooNewError);
    expect(outcome.error.found).toBe(SESSION_SCHEMA_VERSION + 1);
    expect(outcome.error.supported).toBe(SESSION_SCHEMA_VERSION);
    expect(store.getState().status).toBe("disconnected");
    expect(store.getState().session).toBeNull();
  });

  it("does not parse a future blob as the current shape, even if its shape differs", async () => {
    const blob = JSON.stringify({ schemaVersion: 99, account: { id: "C1" } });
    const { store, adapter } = setup(blob);
    const outcome = await restoreWithSchemaCheck(store, adapter);
    expect(outcome).toMatchObject({ status: "disconnected", reason: "schema_too_new" });
  });

  it("leaves the newer blob in storage untouched", async () => {
    const future = JSON.stringify({ ...session, schemaVersion: SESSION_SCHEMA_VERSION + 1 });
    const { storage, store, adapter } = setup(future);
    await restoreWithSchemaCheck(store, adapter);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem()).toBe(future);
  });

  it("reports a corrupted blob as corrupted, not as a newer schema", async () => {
    const { store, adapter } = setup("{not json");
    expect(await restoreWithSchemaCheck(store, adapter)).toEqual({
      status: "disconnected",
      reason: "corrupted",
    });
  });

  it("reports a wrong-shaped blob as corrupted", async () => {
    const { store, adapter } = setup(JSON.stringify({ accountId: 5 }));
    expect(await restoreWithSchemaCheck(store, adapter)).toEqual({
      status: "disconnected",
      reason: "none",
    });
  });

  it.each([["2"], [1.5], [0], [-3], [null]])(
    "treats schemaVersion %j as corrupted, not a newer schema",
    async (schemaVersion) => {
      const blob = JSON.stringify({ ...session, schemaVersion });
      const { store, adapter } = setup(blob);
      const outcome = await restoreWithSchemaCheck(store, adapter);
      expect(outcome.status).toBe("disconnected");
      expect(outcome).not.toMatchObject({ reason: "schema_too_new" });
    },
  );

  it("reports an empty store as none", async () => {
    const { store, adapter } = setup(null);
    expect(await restoreWithSchemaCheck(store, adapter)).toEqual({
      status: "disconnected",
      reason: "none",
    });
  });

  it("assertSessionSchemaSupported ignores non-objects and accepts the current version", () => {
    expect(() => assertSessionSchemaSupported(null)).not.toThrow();
    expect(() => assertSessionSchemaSupported("x")).not.toThrow();
    expect(() => assertSessionSchemaSupported({ schemaVersion: SESSION_SCHEMA_VERSION })).not.toThrow();
    expect(() => assertSessionSchemaSupported({ schemaVersion: SESSION_SCHEMA_VERSION + 1 })).toThrow(
      SessionSchemaTooNewError,
    );
  });
});
