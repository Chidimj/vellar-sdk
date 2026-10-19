import type { VellarWallet } from "../../src/client";

/**
 * create() or connect() was called while another create()/connect() on the same
 * wallet handle was still pending (#650).
 */
export class WalletOperationInProgressError extends Error {
  constructor(
    readonly requested: "create" | "connect",
    readonly inProgress: "create" | "connect",
  ) {
    super(`Cannot ${requested}() while ${inProgress}() is still in progress on this wallet`);
    this.name = "WalletOperationInProgressError";
  }
}

/**
 * Concurrency contract for `create()` and `connect()` on one handle: only one
 * may be in flight at a time. A call made while the other is pending rejects
 * immediately with WalletOperationInProgressError. It is not queued: a queued
 * ceremony would prompt the user again after they already completed one (e.g.
 * a double-clicked button). The pending call settles normally, and
 * `wallet.session` reflects only its outcome. A failed call leaves `session`
 * unchanged and releases the guard so a retry works.
 *
 * Returns a handle that behaves like `wallet` in every other respect
 * (session, pay, policies, x402, ...).
 */
export function withExclusiveCeremonies<W extends VellarWallet>(wallet: W): W {
  let pending: "create" | "connect" | null = null;

  async function exclusive<T>(op: "create" | "connect", run: () => Promise<T>): Promise<T> {
    if (pending) throw new WalletOperationInProgressError(op, pending);
    pending = op;
    try {
      return await run();
    } finally {
      pending = null;
    }
  }

  return new Proxy(wallet, {
    get(target, prop) {
      if (prop === "create") {
        return (input?: { username?: string }) => exclusive("create", () => target.create(input));
      }
      if (prop === "connect") {
        return () => exclusive("connect", () => target.connect());
      }
      // Read through the target so getters like `session` stay live.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
