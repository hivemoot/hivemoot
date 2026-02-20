import { describe, it, expect } from "vitest";
import type Redis from "ioredis";
import { encrypt, decrypt, parseKeyring, ByokCryptoError } from "./crypto";
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
    | "byok_decrypt_failed"
    | "byok_key_version_unavailable";
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

  return client as unknown as Redis & { _store: Map<string, string> };
}

function makeNowIso() {
  return "2026-02-20T21:00:00Z";
}

function flipByte(base64: string): string {
  const buf = Buffer.from(base64, "base64");
  buf[0] ^= 0xff;
  return buf.toString("base64");
}

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
  const encrypted = encrypt(args.plaintextKey, args.keyVersion, args.keyring);
  const envelope: ByokEnvelope = {
    provider: args.provider ?? "anthropic",
    model: args.model ?? "claude-sonnet-4-20250514",
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
    const key = decrypt(
      {
        ciphertext: envelope.ciphertext,
        iv: envelope.iv,
        tag: envelope.tag,
        keyVersion: envelope.keyVersion,
      },
      keyring,
    );

    return {
      ok: true,
      key,
      keyVersion: envelope.keyVersion,
      provider: envelope.provider,
      model: envelope.model,
      fingerprint: envelope.fingerprint,
    };
  } catch (err) {
    if (err instanceof ByokCryptoError && err.code === "byok_key_version_unavailable") {
      return { ok: false, code: "byok_key_version_unavailable" };
    }

    if (err instanceof ByokCryptoError && err.code === "byok_decrypt_failed") {
      return { ok: false, code: "byok_decrypt_failed" };
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
    expect(result).toEqual({ ok: false, code: "byok_decrypt_failed" });
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
    expect(result).toEqual({ ok: false, code: "byok_key_version_unavailable" });
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

    await writeActiveEnvelope({
      redis,
      installationId: "601",
      plaintextKey: "sk-old-version",
      keyVersion: "v1",
      keyring,
    });

    await writeActiveEnvelope({
      redis,
      installationId: "602",
      plaintextKey: "sk-new-version",
      keyVersion: "v2",
      keyring,
    });

    const oldResult = await resolveByokForBot("601", redis, keyring);
    const newResult = await resolveByokForBot("602", redis, keyring);

    expect(oldResult).toEqual(
      expect.objectContaining({
        ok: true,
        key: "sk-old-version",
        keyVersion: "v1",
      }),
    );

    expect(newResult).toEqual(
      expect.objectContaining({
        ok: true,
        key: "sk-new-version",
        keyVersion: "v2",
      }),
    );
  });
});
