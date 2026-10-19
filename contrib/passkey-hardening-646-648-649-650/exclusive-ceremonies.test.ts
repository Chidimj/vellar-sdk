import { describe, expect, it, vi } from "vitest";
import type { VellarWallet } from "../../src/client";
import type { WalletSession } from "../../src/types";
import { withExclusiveCeremonies, WalletOperationInProgressError } from "./exclusive-ceremonies";

function sessionFor(accountId: string): WalletSession {
  return {
    accountId,
    network: "testnet",
    connected: true,
    authMethod: "passkey",
    createdAt: "2026-07-16T10:00:00.000Z",
    lastActiveAt: "2026-07-16T10:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A stand-in for the real handle with the same shape: create/connect write the
// shared `session` when they settle, exactly like createVellarWallet does.
function fakeWallet() {
  let session: WalletSession | null = null;
  const createGate = { current: null as null | ReturnType<typeof deferred<WalletSession>> };
  const connectGate = { current: null as null | ReturnType<typeof deferred<WalletSession>> };
  const create = vi.fn(async () => {
    const gate = createGate.current;
    session = gate ? await gate.promise : sessionFor("CCREATED");
    return session;
  });
  const connect = vi.fn(async () => {
    const gate = connectGate.current;
    session = gate ? await gate.promise : sessionFor("CCONNECTED");
    return session;
  });
  const wallet = {
    get session() {
      return session;
    },
    create,
    connect,
    pay: vi.fn(async () => ({ hash: "h" })),
  } as unknown as VellarWallet;
  return { wallet, create, connect, createGate, connectGate };
}

describe("withExclusiveCeremonies (#650)", () => {
  it("rejects connect() with WalletOperationInProgressError while create() is pending", async () => {
    const f = fakeWallet();
    f.createGate.current = deferred<WalletSession>();
    const wallet = withExclusiveCeremonies(f.wallet);

    const first = wallet.create({ username: "alice" });
    const err = await wallet.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletOperationInProgressError);
    expect(err).toMatchObject({
      name: "WalletOperationInProgressError",
      requested: "connect",
      inProgress: "create",
    });
    expect(f.connect).not.toHaveBeenCalled();

    f.createGate.current.resolve(sessionFor("CCREATED"));
    const session = await first;
    expect(session.accountId).toBe("CCREATED");
    expect(wallet.session).toEqual(session);
  });

  it("rejects a second create() while one is pending: exactly one ceremony runs", async () => {
    const f = fakeWallet();
    f.createGate.current = deferred<WalletSession>();
    const wallet = withExclusiveCeremonies(f.wallet);

    const first = wallet.create();
    await expect(wallet.create()).rejects.toBeInstanceOf(WalletOperationInProgressError);
    f.createGate.current.resolve(sessionFor("CCREATED"));
    await first;

    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("rejects create() while connect() is pending and keeps the connect session", async () => {
    const f = fakeWallet();
    f.connectGate.current = deferred<WalletSession>();
    const wallet = withExclusiveCeremonies(f.wallet);

    const first = wallet.connect();
    await expect(wallet.create()).rejects.toMatchObject({
      requested: "create",
      inProgress: "connect",
    });
    f.connectGate.current.resolve(sessionFor("CCONNECTED"));
    await first;

    expect(wallet.session?.accountId).toBe("CCONNECTED");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("session is never partially overwritten by the rejected call", async () => {
    const f = fakeWallet();
    f.createGate.current = deferred<WalletSession>();
    const wallet = withExclusiveCeremonies(f.wallet);

    const first = wallet.create();
    await wallet.connect().catch(() => undefined);
    expect(wallet.session).toBeNull();
    f.createGate.current.resolve(sessionFor("CCREATED"));
    await first;
    expect(wallet.session?.accountId).toBe("CCREATED");
  });

  it("releases the guard after a failure so a retry works, leaving session untouched", async () => {
    const f = fakeWallet();
    f.connectGate.current = deferred<WalletSession>();
    const wallet = withExclusiveCeremonies(f.wallet);

    const failing = wallet.connect();
    f.connectGate.current.reject(new Error("user cancelled"));
    await expect(failing).rejects.toThrow("user cancelled");
    expect(wallet.session).toBeNull();

    f.connectGate.current = null;
    const session = await wallet.connect();
    expect(wallet.session).toEqual(session);
  });

  it("allows sequential calls after the first settles", async () => {
    const f = fakeWallet();
    const wallet = withExclusiveCeremonies(f.wallet);
    await wallet.create();
    await expect(wallet.connect()).resolves.toMatchObject({ accountId: "CCONNECTED" });
  });

  it("passes every other member through unchanged", async () => {
    const f = fakeWallet();
    const wallet = withExclusiveCeremonies(f.wallet);
    await expect(wallet.pay({} as never)).resolves.toEqual({ hash: "h" });
  });
});
