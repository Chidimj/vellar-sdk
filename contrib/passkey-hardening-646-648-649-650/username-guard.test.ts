import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPasskeyKitConnector,
  type PasskeyKitLike,
  type WalletBackend,
} from "../../src/passkeykit-connector";
import {
  DEFAULT_USERNAME,
  InvalidUsernameError,
  normalizeUsername,
  withUsernameValidation,
} from "./username-guard";

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { credentials: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeKit(): PasskeyKitLike {
  return {
    createWallet: vi
      .fn()
      .mockResolvedValue({ keyIdBase64: "key-123", contractId: "CCONTRACT", signedTx: "xdr" }),
    connectWallet: vi.fn().mockResolvedValue({ keyIdBase64: "key-123", contractId: "CCONTRACT" }),
    sign: vi.fn().mockResolvedValue("signed-xdr"),
  };
}

function fakeBackend(): WalletBackend {
  return {
    submitWalletCreation: vi.fn().mockResolvedValue({ sessionId: "s1" }),
    lookupContractId: vi.fn().mockResolvedValue({ contractId: "CCONTRACT", sessionId: "s2" }),
  };
}

function connectorFor(kit: PasskeyKitLike, backend = fakeBackend()) {
  return createPasskeyKitConnector({
    kit: withUsernameValidation(kit),
    backend,
    network: "testnet",
    appName: "Vellar",
  });
}

describe("normalizeUsername (#648)", () => {
  it("passes a plain username through", () => {
    expect(normalizeUsername("alice")).toBe("alice");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeUsername("  alice  ")).toBe("alice");
  });

  it.each([[undefined], [""], ["   "], ["\t \n"], ["    "]])(
    "falls back to the default for missing or whitespace-only input (%j)",
    (raw) => {
      expect(normalizeUsername(raw)).toBe(DEFAULT_USERNAME);
    },
  );

  it.each([
    ["NUL", "bad\u0000name"],
    ["newline", "line\nbreak"],
    ["tab", "tab\tname"],
    ["DEL", "del\u007fname"],
    ["C1 control", "c1\u0085name"],
    ["line separator", "ls\u2028name"],
    ["paragraph separator", "ps\u2029name"],
  ])("rejects %s with InvalidUsernameError", (_label, raw) => {
    expect(() => normalizeUsername(raw)).toThrow(InvalidUsernameError);
  });

  it("rejects a control character even when it is the only content", () => {
    expect(() => normalizeUsername("\u0000")).toThrow(InvalidUsernameError);
  });

  it("keeps ordinary non-ASCII names intact", () => {
    expect(normalizeUsername("  Zoë 日本  ")).toBe("Zoë 日本");
  });
});

describe("withUsernameValidation through the connector (#648)", () => {
  it("rejects control characters before invoking passkey registration", async () => {
    const kit = fakeKit();
    const backend = fakeBackend();
    await expect(
      connectorFor(kit, backend).createWallet({ username: "al\u0000ice", network: "testnet" }),
    ).rejects.toBeInstanceOf(InvalidUsernameError);
    expect(kit.createWallet).not.toHaveBeenCalled();
    expect(backend.submitWalletCreation).not.toHaveBeenCalled();
  });

  it("registers a whitespace-only username under the default name", async () => {
    const kit = fakeKit();
    await connectorFor(kit).createWallet({ username: "   ", network: "testnet" });
    expect(kit.createWallet).toHaveBeenCalledWith("Vellar", DEFAULT_USERNAME);
  });

  it("registers a valid username trimmed", async () => {
    const kit = fakeKit();
    await connectorFor(kit).createWallet({ username: " alice ", network: "testnet" });
    expect(kit.createWallet).toHaveBeenCalledWith("Vellar", "alice");
  });

  it("leaves connect and sign untouched", async () => {
    const kit = fakeKit();
    const connector = connectorFor(kit);
    await connector.connectWallet("testnet");
    await connector.signTransaction({ xdr: "xdr", network: "testnet" });
    expect(kit.connectWallet).toHaveBeenCalledOnce();
    expect(kit.sign).toHaveBeenCalledOnce();
  });
});
