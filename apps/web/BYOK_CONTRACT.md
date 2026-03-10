# BYOK Contract (Phase 4)

This document defines the stable BYOK storage and runtime contract between this repository (`apps/web`) and the bot runtime (`hivemoot/hivemoot-bot#249`).

Scope:
- Redis storage namespace and envelope schema
- Decryption contract and error semantics
- Runtime environment requirements
- Fail-closed behavior requirements
- Key rotation and recovery runbook

## 1. Storage Namespace

BYOK envelopes are stored in Redis using this key format:

- `hive:byok:{installationId}`

`installationId` is the GitHub App installation ID (string form).

## 2. Envelope Schema

Each Redis value at `hive:byok:{installationId}` is a JSON object with this schema:

| Field | Type | Required | Notes |
|---|---|---|---|
| `provider` | string | yes | LLM provider identifier (e.g. `anthropic`) |
| `model` | string | yes | Model identifier |
| `ciphertext` | string | yes | Base64 AES-256-GCM ciphertext |
| `iv` | string | yes | Base64 IV (12 bytes before base64 encoding) |
| `tag` | string | yes | Base64 GCM auth tag (16 bytes before base64 encoding) |
| `keyVersion` | string | yes | Key version used for encryption (e.g. `v1`) |
| `status` | `"active" \| "revoked"` | yes | Runtime state gate |
| `updatedAt` | string | yes | ISO-8601 timestamp |
| `updatedBy` | string | yes | GitHub login of actor |
| `fingerprint` | string | yes | Always empty string `""` — stored for schema compatibility but never populated or exposed via API |

Compatibility note:
- Legacy envelopes may include `fingerprintLast4`; web runtime normalizes it to `fingerprint`.
- The `fingerprint` field was historically populated with the last 4 characters of the API key. It is now always `""` and never returned in API responses, to prevent any accidental key material leakage.

## 3. Encryption and Decryption Contract

Algorithm and format:
- AES-256-GCM
- `ciphertext`, `iv`, `tag` are base64 strings
- `keyVersion` determines which master key must decrypt the envelope

Keyring contract:
- Master keys are a JSON object `{"<version>": "<64-char-hex-key>"}`.
- Example: `{"v1":"<64-hex>","v2":"<64-hex>"}`.

Decryption flow (bot runtime):
1. Read envelope from `hive:byok:{installationId}`.
2. If no envelope: return `byok_not_configured`.
3. If `status == "revoked"`: return `byok_revoked` (no key material returned).
4. Resolve `keyVersion` in keyring.
5. Decrypt AES-256-GCM using envelope `iv` and `tag`.
6. On success, return plaintext key and non-sensitive metadata.

## 4. Error Codes (Wire Values)

These are the wire values the bot resolver should emit/consume for runtime resolution outcomes:

| Code | Meaning | Bot behavior |
|---|---|---|
| `byok_not_configured` | No envelope for installation | Skip LLM features for this installation |
| `byok_revoked` | Envelope exists but is revoked | Skip LLM features for this installation |
| `byok_decrypt_failed` | Ciphertext/tag/IV invalid or tampered | Fail closed for this request; emit correlation id |
| `byok_key_version_unavailable` | Envelope keyVersion missing from keyring | Fail closed for this request; emit correlation id |

Related server-side configuration errors exposed by web routes:
- `byok_encryption_not_configured`
- `byok_encryption_config_invalid`
- `byok_server_misconfiguration`

## 5. Runtime Environment Variables

Required in this repo (`apps/web`):

| Var | Purpose |
|---|---|
| `HIVEMOOT_REDIS_REST_URL` | Upstash Redis REST URL for BYOK envelope storage |
| `HIVEMOOT_REDIS_REST_TOKEN` | Upstash Redis REST token for BYOK envelope storage |
| `BYOK_ACTIVE_KEY_VERSION` | Key version used for new encryptions |
| `BYOK_MASTER_KEYS` | JSON keyring map (`{"version":"hexKey"}`) |

Required in bot runtime (`hivemoot/hivemoot-bot`):

| Var | Purpose |
|---|---|
| `HIVEMOOT_REDIS_URL` | Same Redis instance that stores BYOK envelopes |
| `BYOK_MASTER_KEYS_JSON` | JSON keyring map used for runtime decryption |

Keyring data contract is identical between `BYOK_MASTER_KEYS` and `BYOK_MASTER_KEYS_JSON`.

## 6. Trust Boundary and Access Pattern

Separation of concerns:
- Web BYOK routes manage lifecycle operations (configure, rotate, revoke, re-encrypt) with authenticated setup sessions.
- Bot runtime resolves keys directly from Redis for execution-time decisions.

Important boundary:
- Bot runtime does not rely on web HTTP routes for key resolution.
- Missing/invalid/tampered key data must always fail closed.

## 7. Key Rotation Runbook

### Add a new key version
1. Generate a new 64-char hex key.
2. Add it to keyring JSON (`BYOK_MASTER_KEYS` / `BYOK_MASTER_KEYS_JSON`) alongside old versions.
3. Set `BYOK_ACTIVE_KEY_VERSION` to the new version in web runtime.

### Migrate envelopes
1. Run re-encryption for installation-scoped envelopes via `/api/byok/re-encrypt`.
2. During migration, keep old key versions in keyring so envelopes still on old versions remain decryptable.
3. Confirm envelopes have moved to the new `keyVersion`.

### Revoke old version
1. After all envelopes are migrated and verified, remove deprecated key version from keyring.
2. Any stale envelope still using removed versions must return `byok_key_version_unavailable` (fail closed).

## 8. Recovery / Incident Response

If decryption failures spike:
1. Keep resolver fail-closed (`byok_decrypt_failed` / `byok_key_version_unavailable`).
2. Log installation ID and correlation ID (never plaintext key or envelope secrets).
3. Validate keyring version availability and Redis data integrity.
4. Re-run installation-scoped re-encryption after configuration repair.

## 9. Acceptance Coverage

Contract behavior is covered by:
- `apps/web/src/server/byok-contract-acceptance.test.ts`
- `apps/web/src/server/byok-store.test.ts`
- `apps/web/src/server/crypto.test.ts`

These tests cover configured resolution, absent/revoked states, tamper detection, key version failures, cross-installation isolation, and migration compatibility.

Real Redis execution path:
- Set `BYOK_ACCEPTANCE_HIVEMOOT_REDIS_REST_URL` (or `HIVEMOOT_REDIS_REST_URL`) plus `BYOK_ACCEPTANCE_HIVEMOOT_REDIS_REST_TOKEN` (or `HIVEMOOT_REDIS_REST_TOKEN`) and run:
  - `npm test -- src/server/byok-contract-acceptance.test.ts`
- The live-Redis block verifies resolver behavior through actual Redis transport rather than an in-memory mock.
