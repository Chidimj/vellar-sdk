# Issues #646, #648, #649, #650

Standalone wrappers and tests, scoped to `contrib/` per `CONTRIBUTING.md`. They compose with the SDK through its existing seams (`kit`, `SessionStorageAdapter`, the `VellarWallet` handle), so nothing outside this folder changes.

```bash
npx vitest run contrib/passkey-hardening-646-648-649-650
```

## #646: Reject a passkey assertion for a different RP ID

`rp-id-guard.ts` exports `withRpIdGuard(kit, expectedRpId)` and `PasskeyRpIdMismatchError`.

```ts
const vellar = createVellarWallet({ ..., kit: withRpIdGuard(passkeyKit, "app.vellar.io") });
```

Expected validation behavior (also documented in the source):

- Before any create, connect or sign, the kit's own `rpId` must equal the expected one.
- After create/connect, the RP ID reported with the result (or the kit's) must equal it. The error is thrown before the result reaches the connector, so the backend never sees a deployment or lookup for a credential scoped to another origin.
- With an expected RP ID configured, a result that reports no RP ID fails closed.

Cross-reference: the "Threat model" page (`website/content/docs/architecture/threat-model.md`). The chain still decides what a signature can do; this narrows which credentials the client accepts and does not replace on-chain signer verification.

Lift into core: add an optional `rpId` to `PasskeyKitConnectorOptions` / `VellarWalletConfig` and call the same checks inside `createWallet`, `connectWallet` and `signTransaction` in `src/passkeykit-connector.ts`.

## #648: Usernames the passkey RP would reject

`username-guard.ts` exports `normalizeUsername`, `withUsernameValidation(kit)` and `InvalidUsernameError`.

Accepted format for `create({ username })`:

- surrounding whitespace (including Unicode spaces) is trimmed;
- missing, empty or whitespace-only becomes `"Vellar user"`;
- a control character (Unicode Cc, U+2028, U+2029) inside the name throws `InvalidUsernameError` before registration is invoked.

Lift into core: use `normalizeUsername` in `createWallet` in `src/passkeykit-connector.ts` (replacing `input.username?.trim() || "Vellar user"`) and copy the format into the `CreateWalletInput.username` comment in `src/types.ts`.

## #649: `session.restore` and a newer schema

`session-schema-guard.ts` exports `SESSION_SCHEMA_VERSION`, `SessionSchemaTooNewError`, `createVersionedWebStorageAdapter` and `restoreWithSchemaCheck`.

- Coordinated with #220: the field is `schemaVersion` (integer >= 1); a session with no field is version 1.
- A stored version above `SESSION_SCHEMA_VERSION` is rejected with `SessionSchemaTooNewError` before any shape check, so it is never parsed as the current shape, and the stored blob is left untouched.
- `restoreWithSchemaCheck` returns `reason: "schema_too_new"` (with the error), `"corrupted"` or `"none"`, so a future-schema session is distinguishable from a corrupted one.
- A non-integer or non-positive version is treated as corrupted, not as newer.

Lift into core: add `schemaVersion?: number` to `WalletSession`, stamp it in `start()`, call `assertSessionSchemaSupported` in `restore()` and in `createWebStorageAdapter.load`.

## #650: Concurrent `create()` and `connect()`

`exclusive-ceremonies.ts` exports `withExclusiveCeremonies(wallet)` and `WalletOperationInProgressError`.

Concurrency contract (for the `create`/`connect` rows of the README API table):

> `create()` and `connect()` share one handle and one `session`, so only one may be in flight at a time. A call made while the other is pending rejects immediately with `WalletOperationInProgressError`; it is not queued, so the user is never prompted twice. The pending call settles normally and `wallet.session` reflects only its outcome. A failed call leaves `session` unchanged and the handle usable again.

Lift into core: add the same `pending` guard around `create`/`connect` in `src/client.ts` and put the paragraph above under the README API table.
