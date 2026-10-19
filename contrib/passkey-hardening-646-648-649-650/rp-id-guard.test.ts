import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPasskeyKitConnector,
  type PasskeyKitLike,
  type WalletBackend,
} from "../../src/passkeykit-connector";
import { PasskeyRpIdMismatchError, withRpIdGuard } from "./rp-id-guard";

const RP_ID = "app.vellar.io";

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { credentials: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeKit(overrides: Partial<PasskeyKitLike> = {}): PasskeyKitLike {
  return {
    createWallet: vi.fn().mockResolvedValue({
      keyIdBase64: "key-123",
      contractId: "CCONTRACT",
      signedTx: "deploy-xdr",
      rpId: RP_ID,
    }),
    connectWallet: vi
      .fn()
      .mockResolvedValue({ keyIdBase64: "key-123", contractId: "CCONTRACT", rpId: RP_ID }),
    sign: vi.fn().mockResolvedValue("signed-xdr"),
    ...overrides,
  };
}

function fakeBackend(): WalletBackend {
  return {
    submitWalletCreation: vi.fn().mockResolvedValue({ sessionId: "server-session-1" }),
    lookupContractId: vi
      .fn()
      .mockResolvedValue({ contractId: "CCONTRACT", sessionId: "server-session-2" }),
  };
}

function connectorFor(kit: PasskeyKitLike, backend = fakeBackend()) {
  return createPasskeyKitConnector({
    kit: withRpIdGuard(kit, RP_ID),
    backend,
    network: "testnet",
    appName: "Vellar",
  });
}

describe("withRpIdGuard (#646)", () => {
  it("accepts a ceremony whose RP ID matches", async () => {
    const session = await connectorFor(fakeKit()).connectWallet("testnet");
    expect(session.accountId).toBe("CCONTRACT");
  });

  it("accepts a create ceremony whose RP ID matches and submits to the backend", async () => {
    const backend = fakeBackend();
    await connectorFor(fakeKit(), backend).createWallet({ network: "testnet" });
    expect(backend.submitWalletCreation).toHaveBeenCalledOnce();
  });

  it("rejects a connect assertion for a different RP ID with PasskeyRpIdMismatchError", async () => {
    const kit = fakeKit({
      connectWallet: vi
        .fn()
        .mockResolvedValue({ keyIdBase64: "k", contractId: "CCONTRACT", rpId: "evil.example" }),
    });
    const err = await connectorFor(kit)
      .connectWallet("testnet")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasskeyRpIdMismatchError);
    expect(err).toMatchObject({ name: "PasskeyRpIdMismatchError", expected: RP_ID });
    expect((err as Error).message).toContain("evil.example");
  });

  it("rejects a create ceremony for a different RP ID before backend submission", async () => {
    const kit = fakeKit({
      createWallet: vi.fn().mockResolvedValue({
        keyIdBase64: "k",
        contractId: "CCONTRACT",
        signedTx: "deploy-xdr",
        rpId: "evil.example",
      }),
    });
    const backend = fakeBackend();
    await expect(
      connectorFor(kit, backend).createWallet({ network: "testnet" }),
    ).rejects.toBeInstanceOf(PasskeyRpIdMismatchError);
    expect(backend.submitWalletCreation).not.toHaveBeenCalled();
  });

  it("rejects a kit bound to another RP ID before any ceremony or signing", async () => {
    const kit = fakeKit({ rpId: "evil.example" });
    const connector = connectorFor(kit);
    await expect(connector.connectWallet("testnet")).rejects.toBeInstanceOf(
      PasskeyRpIdMismatchError,
    );
    await expect(connector.createWallet({ network: "testnet" })).rejects.toBeInstanceOf(
      PasskeyRpIdMismatchError,
    );
    await expect(connector.signTransaction({ xdr: "x", network: "testnet" })).rejects.toBeInstanceOf(
      PasskeyRpIdMismatchError,
    );
    expect(kit.connectWallet).not.toHaveBeenCalled();
    expect(kit.createWallet).not.toHaveBeenCalled();
    expect(kit.sign).not.toHaveBeenCalled();
  });

  it("fails closed when no RP ID is reported by the result or the kit", async () => {
    const kit = fakeKit({
      connectWallet: vi.fn().mockResolvedValue({ keyIdBase64: "k", contractId: "CCONTRACT" }),
    });
    const err = await connectorFor(kit)
      .connectWallet("testnet")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasskeyRpIdMismatchError);
    expect((err as PasskeyRpIdMismatchError).actual).toBeUndefined();
  });

  it("falls back to the kit's rpId when the result does not report one", async () => {
    const kit = fakeKit({
      rpId: RP_ID,
      connectWallet: vi.fn().mockResolvedValue({ keyIdBase64: "k", contractId: "CCONTRACT" }),
    });
    await expect(connectorFor(kit).connectWallet("testnet")).resolves.toBeDefined();
  });

  it("signs when the kit's RP ID matches", async () => {
    const result = await connectorFor(fakeKit({ rpId: RP_ID })).signTransaction({
      xdr: "xdr",
      network: "testnet",
    });
    expect(result.signedXdr).toBe("signed-xdr");
  });

  it("exposes the underlying kit's wallet and rpId unchanged", () => {
    const wallet = {};
    const guarded = withRpIdGuard(fakeKit({ rpId: RP_ID, wallet }), RP_ID);
    expect(guarded.rpId).toBe(RP_ID);
    expect(guarded.wallet).toBe(wallet);
  });
});
