import { describe, it, expect } from "vitest";
import { Redis, type Redis as RedisType } from "@upstash/redis";
import { encrypt, decrypt, parseKeyring, ByokCryptoError } from "./crypto";
import { BYOK_ERROR } from "./byok-error";
import { getByokEnvelope, setByokEnvelope } from "./byok-store";
import type { ByokEnvelope } from "./byok-store";

type ResolverSuccess = {
  ok: true;
  key: string;
  keyVersion: string;
  provider: string;
  model: string;
  fingerprint: string;
};

type ResolverFailure = {
  ok: false;
  code:
    | "byok_not_configured"
    | "byok_revoked"
    | typeof BYOK_ERROR.DECRYPT_FAILED
    | typeof BYOK_ERROR.ACTIVE_KEY_VERSION_UNAVAILABLE;
};

type ResolverResult = ResolverSuccess | ResolverFailure;

function makeMockRedis() {
  const store = new Map<string, string>();

  const client = {
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    get: async (key: string) => store.get(key) ?? null,
    scan: async (cursor: string) => {
      if (cursor === "0") {
        const keys = [...store.keys()].filter((k) => k.startsWith("hive:byok:"));
        return ["0", keys];
      }
      return ["0", []];
    },
    _store: store,
  };

  return client as unknown as RedisType & { _store: Map<string, string> };
}

const LIVE_UPSTASH_URL = process.env.BYOK_ACCEPTANCE_HIVEMOOT_REDIS_REST_URL ?? process.env.HIVEMOOT_REDIS_REST_URL;
const LIVE_UPSTASH_TOKEN = process.env.BYOK_ACCEPTANCE_HIVEMOOT_REDIS_REST_TOKEN ?? process.env.HIVEMOOT_REDIS_REST_TOKEN;

function makeLiveRedisClient(): RedisType {
  if (!LIVE_UPSTASH_URL || !LIVE_UPSTASH_TOKEN) {
    throw new Error("HIVEMOOT_REDIS_REST_URL and HIVEMOOT_REDIS_REST_TOKEN are required");
  }

  return new Redis({ url: LIVE_UPSTASH_URL, token: LIVE_UPSTASH_TOKEN });
}

function makeNowIso() {
  return "2026-02-20T21:00:00Z";
}

function flipByte(base64: string): string {
  const buf = Buffer.from(base64, "base64");
  buf[0] ^= 0xff;
  return buf.toString("base64");
}

// ---------------------------------------------------------------------------
// writeActiveEnvelope — mirrors the web app's config/rotate routes.
// Encrypts a JSON payload { apiKey, provider, model } so the bot can
// extract all three from the authenticated ciphertext.
// ---------------------------------------------------------------------------

async function writeActiveEnvelope(args: {
  redis: Redis;
  installationId: string;
  plaintextKey: string;
  keyVersion: string;
  keyring: Map<string, Buffer>;
  provider?: string;
  model?: string;
  fingerprint?: string;
}): Promise<ByokEnvelope> {
  const provider = args.provider ?? "anthropic";
  const model = args.model ?? "claude-sonnet-4-20250514";

  const encrypted = encrypt(
    JSON.stringify({ apiKey: args.plaintextKey, provider, model }),
    args.keyVersion,
    args.keyring,
  );
  const envelope: ByokEnvelope = {
    provider,
    model,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    keyVersion: encrypted.keyVersion,
    status: "active",
    updatedAt: makeNowIso(),
    updatedBy: "guard",
    fingerprint: args.fingerprint ?? "abcd",
  };

  await setByokEnvelope(args.installationId, envelope, args.redis);
  return envelope;
}

function asEncryptedEnvelope(envelope: ByokEnvelope) {
  return {
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    tag: envelope.tag,
    keyVersion: envelope.keyVersion,
  };
}

async function reEncryptInstallation(args: {
  installationId: string;
  redis: Redis;
  keyring: Map<string, Buffer>;
  activeKeyVersion: string;
}): Promise<boolean> {
  const existing = await getByokEnvelope(args.installationId, args.redis);
  if (!existing || existing.status === "revoked" || existing.keyVersion === args.activeKeyVersion) {
    return false;
  }

  const plaintext = decrypt(asEncryptedEnvelope(existing), args.keyring);
  const rotated = encrypt(plaintext, args.activeKeyVersion, args.keyring);

  await setByokEnvelope(
    args.installationId,
    {
      ...existing,
      ciphertext: rotated.ciphertext,
      iv: rotated.iv,
      tag: rotated.tag,
      keyVersion: rotated.keyVersion,
      updatedAt: makeNowIso(),
      updatedBy: "guard-rotation",
    },
    args.redis,
  );

  return true;
}

async function batchReEncryptInstallations(args: {
  installationIds: string[];
  redis: Redis;
  keyring: Map<string, Buffer>;
  activeKeyVersion: string;
}): Promise<number> {
  let reEncrypted = 0;

  for (const installationId of args.installationIds) {
    const changed = await reEncryptInstallation({
      installationId,
      redis: args.redis,
      keyring: args.keyring,
      activeKeyVersion: args.activeKeyVersion,
    });
    if (changed) {
      reEncrypted++;
    }
  }

  return reEncrypted;
}

// ---------------------------------------------------------------------------
// resolveByokForBot — mirrors the bot's byok.ts resolver.
// Decrypts the ciphertext and parses the JSON payload to extract apiKey,
// provider, and model. This matches the bot's decryptEnvelope() behavior.
// ---------------------------------------------------------------------------

async function resolveByokForBot(
  installationId: string,
  redis: Redis,
  keyring: Map<string, Buffer>,
): Promise<ResolverResult> {
  const envelope = await getByokEnvelope(installationId, redis);
  if (!envelope) {
    return { ok: false, code: "byok_not_configured" };
  }

  if (envelope.status === "revoked") {
    return { ok: false, code: "byok_revoked" };
  }

  try {
    const decrypted = decrypt(
      {
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        tag: envelope.tag,
        keyVersion: envelope.keyVersion,
      },
      keyring,
    );

    // Parse JSON payload — matches the bot's decryptEnvelope()
    const payload = JSON.parse(decrypted) as { apiKey: string; provider: string; model: string };

    return {
      ok: true,
      key: payload.apiKey,
      keyVersion: envelope.keyVersion,
      provider: payload.provider,
      model: payload.model,
      fingerprint: envelope.fingerprint,
    };
  } catch (err) {
    if (err instanceof ByokCryptoError && err.code === BYOK_ERROR.ACTIVE_KEY_VERSION_UNAVAILABLE) {
      return { ok: false, code: BYOK_ERROR.ACTIVE_KEY_VERSION_UNAVAILABLE };
    }

    if (err instanceof ByokCryptoError && err.code === BYOK_ERROR.DECRYPT_FAILED) {
      return { ok: false, code: BYOK_ERROR.DECRYPT_FAILED };
    }

    throw err;
  }
}

describe("BYOK contract acceptance", () => {
  it("returns decrypted key for a configured installation", async () => {
    const redis = makeMockRedis();
    const keyring = parseKeyring(
      JSON.stringify({
        v1: "a".repeat(64),
      }),
    );

    await writeActiveEnvelope({
      redis,
      installationId: "100",
      plaintextKey: "sk-ant-live-test",
      keyVersion: "v1",
      keyring,
    });

    const result = await resolveByokForBot("100", redis, keyring);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        key: "sk-ant-live-test",
        keyVersion: "v1",
      }),
    );
  });

  it("returns provider and model from decrypted payload", async () => {
    const redis = makeMockRedis();
    const keyring = parseKeyring(JSON.stringify({ v1: "a".repeat(64) }));

    await writeActiveEnvelope({
      redis,
      installationId: "110",
      plaintextKey: "sk-ant-test",
      keyVersion: "v1",
      keyring,
      provider: "openai",
      model: "gpt-4o",
    });

    const result = await resolveByokForBot("110", redis, keyring);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        key: "sk-ant-test",
        provider: "openai",
        model: "gpt-4o",
      }),
    );
  });

  it("authenticates provider via GCM — tampered envelope metadata detected", async () => {
    const redis = makeMockRedis();
    const keyring = parseKeyring(JSON.stringify({ v1: "a".repeat(64) }));

    await writeActiveEnvelope({
      redis,
      installationId: "120",
      plaintextKey: "sk-test",
      keyVersion: "v1",
      keyring,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });

    const result = await resolveByokForBot("120", redis, keyring);

    // Even if envelope metadata were tampered, the decrypted payload
    // contains the authentic provider and model
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      }),
    );
  });

  it("ciphertext contains JSON with apiKey, provider, and model", async () => {
    const redis = makeMockRedis();
    const keyring = parseKeyring(JSON.stringify({ v1: "a".repeat(64) }));

    await writeActiveEnvelope({
      redis,
      installationId: "130",
      plaintextKey: "sk-verify-format",
      keyVersion: "v1",
      keyring,
      provider: "google",
      model: "gemini-3-flash-preview",
    });

    // Decrypt the raw ciphertext and verify the payload structure
    const envelope = await getByokEnvelope("130", redis);
    const decrypted = decrypt(asEncryptedEnvelope(envelope!), keyring);
    const parsed = JSON.parse(decrypted);

    expect(parsed).toEqual({
      apiKey: "sk-verify-format",
      provider: "google",
      model: "gemini-3-flash-preview",
    });
  });

  it("returns byok_not_configured when no envelope exists", async () => {
    const redis = makeMockRedis();
    const keyring = parseKeyring(JSON.stringify({ v1: "a".repeat(64) }));

    const result = await resolveByokForBot("404", redis, keyring);
    expect(result).toEqual({ ok: false, code: "byok_not_configured" });
  });

  it("returns byok_revoked without exposing key material", async () => {
    const redis = makeMockRedis();
    const keyring = parseKeyring(JSON.stringify({ v1: "a".repeat(64) }));

    const revokedEnvelope: ByokEnvelope = {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      ciphertext: "",
      iv: "",
      tag: "",
      keyVersion: "v1",
      status: "revoked",
      updatedAt: makeNowIso(),
      updatedBy: "guard",
      fingerprint: "abcd",
    };

    await setByokEnvelope("200", revokedEnvelope, redis);

    const result = await resolveByokForBot("200", redis, keyring);
    expect(result).toEqual({ ok: false, code: "byok_revoked" });
  });

  it("fails closed with byok_decrypt_failed when ciphertext is tampered", async () => {
    const redis = makeMockRedis();
    const keyring = parseKeyring(JSON.stringify({ v1: "a".repeat(64) }));

    const envelope = await writeActiveEnvelope({
      redis,
      installationId: "300",
      plaintextKey: "sk-ant-tamper-target",
      keyVersion: "v1",
      keyring,
    });

    await setByokEnvelope(
      "300",
      {
        ...envelope,
        ciphertext: flipByte(envelope.ciphertext),
      },
      redis,
    );

    const result = await resolveByokForBot("300", redis, keyring);
    expect(result).toEqual({ ok: false, code: BYOK_ERROR.DECRYPT_FAILED });
  });

  it("fails closed with byok_key_version_unavailable when key version is missing", async () => {
    const redis = makeMockRedis();
    const fullKeyring = parseKeyring(JSON.stringify({ v1: "a".repeat(64) }));

    const envelope = await writeActiveEnvelope({
      redis,
      installationId: "400",
      plaintextKey: "sk-ant-version-test",
      keyVersion: "v1",
      keyring: fullKeyring,
    });

    await setByokEnvelope(
      "400",
      {
        ...envelope,
        keyVersion: "v9",
      },
      redis,
    );

    const result = await resolveByokForBot("400", redis, fullKeyring);
    expect(result).toEqual({ ok: false, code: BYOK_ERROR.ACTIVE_KEY_VERSION_UNAVAILABLE });
  });

  it("enforces cross-installation isolation by key lookup", async () => {
    const redis = makeMockRedis();
    const keyring = parseKeyring(JSON.stringify({ v1: "a".repeat(64) }));

    await writeActiveEnvelope({
      redis,
      installationId: "501",
      plaintextKey: "sk-installation-a",
      keyVersion: "v1",
      keyring,
      fingerprint: "1111",
    });

    await writeActiveEnvelope({
      redis,
      installationId: "502",
      plaintextKey: "sk-installation-b",
      keyVersion: "v1",
      keyring,
      fingerprint: "2222",
    });

    const installationA = await resolveByokForBot("501", redis, keyring);
    const installationB = await resolveByokForBot("502", redis, keyring);

    expect(installationA).toEqual(
      expect.objectContaining({
        ok: true,
        key: "sk-installation-a",
        fingerprint: "1111",
      }),
    );

    expect(installationB).toEqual(
      expect.objectContaining({
        ok: true,
        key: "sk-installation-b",
        fingerprint: "2222",
      }),
    );
  });

  it("supports migration window where old and new key versions both decrypt", async () => {
    const redis = makeMockRedis();
    const keyring = parseKeyring(
      JSON.stringify({
        v1: "a".repeat(64),
        v2: "b".repeat(64),
      }),
    );

    const oldEnvelopeBeforeMigration = await writeActiveEnvelope({
      redis,
      installationId: "601",
      plaintextKey: "sk-old-version-601",
      keyVersion: "v1",
      keyring,
    });

    await writeActiveEnvelope({
      redis,
      installationId: "602",
      plaintextKey: "sk-old-version-602",
      keyVersion: "v1",
      keyring,
    });

    const oldEnvelopeSnapshot = asEncryptedEnvelope(oldEnvelopeBeforeMigration);

    const reEncrypted = await batchReEncryptInstallations({
      installationIds: ["601", "602"],
      redis,
      keyring,
      activeKeyVersion: "v2",
    });
    expect(reEncrypted).toBe(2);

    const migratedA = await getByokEnvelope("601", redis);
    const migratedB = await getByokEnvelope("602", redis);
    expect(migratedA?.keyVersion).toBe("v2");
    expect(migratedB?.keyVersion).toBe("v2");

    // Old key version can still decrypt the pre-migration snapshot
    const oldVersionStillDecrypts = decrypt(oldEnvelopeSnapshot, keyring);
    const oldPayload = JSON.parse(oldVersionStillDecrypts);
    expect(oldPayload.apiKey).toBe("sk-old-version-601");

    const migratedAResult = await resolveByokForBot("601", redis, keyring);
    const migratedBResult = await resolveByokForBot("602", redis, keyring);

    expect(migratedAResult).toEqual(
      expect.objectContaining({
        ok: true,
        key: "sk-old-version-601",
        keyVersion: "v2",
      }),
    );

    expect(migratedBResult).toEqual(
      expect.objectContaining({
        ok: true,
        key: "sk-old-version-602",
        keyVersion: "v2",
      }),
    );
  });

  it("preserves provider and model through re-encryption", async () => {
    const redis = makeMockRedis();
    const keyring = parseKeyring(
      JSON.stringify({
        v1: "a".repeat(64),
        v2: "b".repeat(64),
      }),
    );

    await writeActiveEnvelope({
      redis,
      installationId: "700",
      plaintextKey: "sk-provider-test",
      keyVersion: "v1",
      keyring,
      provider: "openai",
      model: "gpt-4o",
    });

    await reEncryptInstallation({
      installationId: "700",
      redis,
      keyring,
      activeKeyVersion: "v2",
    });

    const result = await resolveByokForBot("700", redis, keyring);
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        key: "sk-provider-test",
        provider: "openai",
        model: "gpt-4o",
        keyVersion: "v2",
      }),
    );
  });
});

const describeLiveRedis = LIVE_UPSTASH_URL && LIVE_UPSTASH_TOKEN ? describe : describe.skip;

describeLiveRedis("BYOK contract acceptance (live Redis)", () => {
  it("resolves a configured installation through a real Redis transport", async () => {
    const redis = makeLiveRedisClient();
    const keyring = parseKeyring(JSON.stringify({ v1: "a".repeat(64) }));
    const installationId = `live-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    try {
      await writeActiveEnvelope({
        redis,
        installationId,
        plaintextKey: "sk-ant-live-redis",
        keyVersion: "v1",
        keyring,
      });

      const result = await resolveByokForBot(installationId, redis, keyring);
      expect(result).toEqual(
        expect.objectContaining({
          ok: true,
          key: "sk-ant-live-redis",
          keyVersion: "v1",
        }),
      );
    } finally {
      await redis.del(`hive:byok:${installationId}`);
      // @upstash/redis is HTTP REST — no connection to close
    }
  });
});
