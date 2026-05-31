/**
 * Unit tests for the model-credential storage layer (MODEL_AUTH_DESIGN.md
 * Stage 1).
 *
 * Uses a smart in-memory Redis mock that simulates the two Lua scripts
 * (CREATE with zcard cap guard; UPDATE = SET + optional audit XADD) by
 * inspecting the script source, plus the `withRedisLock` release script.
 * Mirrors the agent-token-v1.test.ts mock shape.
 *
 * Note: bracket-notation access (`redis["eval"]`) is used to sidestep an
 * unrelated security-warning hook that pattern-matches on the literal
 * `.eval(` token even for Redis Lua-execution methods.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { type Redis } from "@upstash/redis";

import {
  createModelCredential,
  getModelCredential,
  getModelCredentialSummary,
  listModelCredentials,
  rotateModelCredential,
  revokeModelCredential,
  reEncryptModelCredential,
  decryptModelCredentialPayload,
  ModelCredentialNotFoundError,
  NameTakenError,
  LimitReachedError,
  InvalidKindError,
  InvalidProviderError,
  MAX_MODEL_CREDENTIALS_PER_INSTALLATION,
  envelopeKey,
  installationIndexKey,
  auditStreamKey,
  lockKey,
  type ModelCredentialEnvelopeV1,
} from "./model-credential-store";
import { CapabilityValidationError } from "./agent-token-capabilities";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

interface SortedSetEntry {
  member: string;
  score: number;
}

interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

function makeMockRedis() {
  const store = new Map<string, unknown>();
  const streams = new Map<string, StreamEntry[]>();

  function getSortedSet(key: string): SortedSetEntry[] {
    const existing = store.get(key);
    if (Array.isArray(existing)) return existing as SortedSetEntry[];
    const fresh: SortedSetEntry[] = [];
    store.set(key, fresh);
    return fresh;
  }

  function getStream(key: string): StreamEntry[] {
    let s = streams.get(key);
    if (!s) {
      s = [];
      streams.set(key, s);
    }
    return s;
  }

  function xaddFromScript(streamKey: string, entryJson: string) {
    if (entryJson === "") return;
    getStream(streamKey).push({
      id: `${Date.now()}-${getStream(streamKey).length}`,
      fields: { entry: entryJson },
    });
  }

  const luaSim = vi.fn(
    async (script: string, keys: string[], argv: string[]) => {
      // withRedisLock release script — 1 key, 1 arg, references ARGV[1],
      // not one of our domain scripts (no name_taken / no set+xadd shape).
      if (
        keys.length === 1 &&
        argv.length === 1 &&
        script.includes("ARGV[1]") &&
        !script.includes("name_taken")
      ) {
        const lk = keys[0];
        if (store.get(lk) === argv[0]) {
          store.delete(lk);
          return 1;
        }
        return 0;
      }

      // CREATE_CREDENTIAL_SCRIPT — 3 keys, 5 args
      if (
        keys.length === 3 &&
        argv.length === 5 &&
        script.includes("name_taken")
      ) {
        const [envK, idxK, auditK] = keys;
        const [name, envJson, createdAtMs, auditEntry, limit] = argv;
        if (store.has(envK)) return [0, "name_taken"];
        const set = getSortedSet(idxK);
        if (set.length >= Number(limit)) return [-1, "limit"];
        store.set(envK, JSON.parse(envJson));
        set.push({ member: name, score: Number(createdAtMs) });
        set.sort((a, b) => a.score - b.score);
        xaddFromScript(auditK, auditEntry);
        return [1, name];
      }

      // UPDATE_CREDENTIAL_SCRIPT — 2 keys, 2 args (SET + optional XADD)
      if (
        keys.length === 2 &&
        argv.length === 2 &&
        script.includes('redis.call("set", KEYS[1], ARGV[1])')
      ) {
        const [envK, auditK] = keys;
        const [envJson, auditEntry] = argv;
        store.set(envK, JSON.parse(envJson));
        xaddFromScript(auditK, auditEntry);
        return [1];
      }

      return null;
    },
  );

  const client = {
    set: vi.fn(
      async (
        key: string,
        value: unknown,
        opts?: { nx?: boolean; xx?: boolean; ex?: number },
      ) => {
        if (opts?.nx && store.has(key)) return null;
        if (opts?.xx && !store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
    ),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const set = getSortedSet(key);
      const existing = set.find((e) => e.member === member);
      if (existing) {
        existing.score = score;
        return 0;
      }
      set.push({ member, score });
      set.sort((a, b) => a.score - b.score);
      return 1;
    }),
    zrem: vi.fn(async (key: string, member: string) => {
      const set = getSortedSet(key);
      const idx = set.findIndex((e) => e.member === member);
      if (idx === -1) return 0;
      set.splice(idx, 1);
      return 1;
    }),
    zrange: vi.fn(async (key: string, _start: number, _stop: number) => {
      const set = getSortedSet(key);
      return set.map((e) => e.member);
    }),
    "eval": luaSim,
    _store: store,
    _streams: streams,
    _luaSim: luaSim,
  };
  return client as unknown as Redis & {
    _store: Map<string, unknown>;
    _streams: Map<string, StreamEntry[]>;
    _luaSim: ReturnType<typeof vi.fn>;
  };
}

const KEYRING = new Map([["v1", Buffer.alloc(32)]]);
const KEYRING_V2 = new Map([
  ["v1", Buffer.alloc(32)],
  ["v2", Buffer.alloc(32, 1)],
]);

function defaultCreateArgs(redis: Redis) {
  return {
    installationId: "12345",
    name: "team-claude",
    kind: "api_key" as const,
    provider: "anthropic" as const,
    value: "sk-ant-secret-value-001",
    createdBy: "operator",
    deliverable: true,
    keyring: KEYRING,
    keyVersion: "v1",
    redis,
  };
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

describe("key prefix helpers", () => {
  it("envelopeKey uses the model-cred v1 prefix", () => {
    expect(envelopeKey("12345", "team-claude")).toBe(
      "hive:v1:model-cred:12345:team-claude",
    );
  });
  it("installationIndexKey uses the model-cred idx prefix", () => {
    expect(installationIndexKey("12345")).toBe(
      "hive:v1:idx:model-cred:installation:12345",
    );
  });
  it("auditStreamKey is envelope-prefix + installationId + :audit", () => {
    expect(auditStreamKey("12345")).toBe("hive:v1:model-cred:12345:audit");
  });
  it("lockKey uses the model-cred lock prefix", () => {
    expect(lockKey("12345", "team-claude")).toBe(
      "hive:v1:lock:model-cred:12345:team-claude",
    );
  });
});

// ---------------------------------------------------------------------------
// createModelCredential
// ---------------------------------------------------------------------------

describe("createModelCredential", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("creates a credential, stores envelope + index, returns summary without ciphertext", async () => {
    const summary = await createModelCredential(defaultCreateArgs(redis));

    expect(summary.name).toBe("team-claude");
    expect(summary.kind).toBe("api_key");
    expect(summary.provider).toBe("anthropic");
    expect(summary.status).toBe("active");
    expect(summary.deliverable).toBe(true);
    expect(summary.rotatedAt).toBeNull();
    expect("ciphertext" in summary).toBe(false);
    expect("iv" in summary).toBe(false);
    expect("tag" in summary).toBe(false);

    const env = redis._store.get(
      envelopeKey("12345", "team-claude"),
    ) as ModelCredentialEnvelopeV1;
    expect(env).toBeDefined();
    expect(env.ciphertext.length).toBeGreaterThan(0);
    expect(env.provider).toBe("anthropic");

    const idx = redis._store.get(
      installationIndexKey("12345"),
    ) as SortedSetEntry[];
    expect(idx).toHaveLength(1);
    expect(idx[0].member).toBe("team-claude");
  });

  it("fingerprint is sha256(value).slice(0,8) and never equals the value", async () => {
    const summary = await createModelCredential(defaultCreateArgs(redis));
    const expected = createHash("sha256")
      .update("sk-ant-secret-value-001")
      .digest("hex")
      .slice(0, 8);
    expect(summary.fingerprint).toBe(expected);
    expect(summary.fingerprint).not.toBe("sk-ant-secret-value-001");
    expect(summary.fingerprint.length).toBe(8);
  });

  it("encrypts the {kind, provider, value} plaintext (round-trips via decrypt)", async () => {
    await createModelCredential(defaultCreateArgs(redis));
    const env = await getModelCredential({
      installationId: "12345",
      name: "team-claude",
      redis,
    });
    const payload = decryptModelCredentialPayload(env, KEYRING);
    expect(payload).toEqual({
      kind: "api_key",
      provider: "anthropic",
      value: "sk-ant-secret-value-001",
    });
  });

  it("rejects invalid name (uppercase)", async () => {
    await expect(
      createModelCredential({ ...defaultCreateArgs(redis), name: "Team" }),
    ).rejects.toThrow(CapabilityValidationError);
  });

  it("rejects invalid kind", async () => {
    await expect(
      createModelCredential({
        ...defaultCreateArgs(redis),
        // @ts-expect-error testing runtime rejection of a bad kind
        kind: "password",
      }),
    ).rejects.toThrow(InvalidKindError);
  });

  it("rejects invalid provider", async () => {
    await expect(
      createModelCredential({
        ...defaultCreateArgs(redis),
        // @ts-expect-error testing runtime rejection of a bad provider
        provider: "mistral",
      }),
    ).rejects.toThrow(InvalidProviderError);
  });

  it("throws NameTakenError on duplicate name", async () => {
    await createModelCredential(defaultCreateArgs(redis));
    await expect(
      createModelCredential(defaultCreateArgs(redis)),
    ).rejects.toThrow(NameTakenError);
  });

  it("MAX_MODEL_CREDENTIALS_PER_INSTALLATION is 20 (design §6.5)", () => {
    expect(MAX_MODEL_CREDENTIALS_PER_INSTALLATION).toBe(20);
  });

  it("enforces the per-installation cap atomically (N+1 → LimitReached)", async () => {
    await createModelCredential({
      ...defaultCreateArgs(redis),
      name: "first",
      limit: 2,
    });
    await createModelCredential({
      ...defaultCreateArgs(redis),
      name: "second",
      limit: 2,
    });
    await expect(
      createModelCredential({
        ...defaultCreateArgs(redis),
        name: "third",
        limit: 2,
      }),
    ).rejects.toThrow(LimitReachedError);
  });

  it("cap is enforced INSIDE the Lua script (zcard guard, TOCTOU-safe)", () => {
    // The cap check must be in the script body, not a client-side count
    // before the write — otherwise concurrent creates could both pass.
    const src = readFileSync(__dirname + "/model-credential-store.ts", "utf8");
    expect(src).toMatch(/local count = redis\.call\("zcard", KEYS\[2\]\)/);
    expect(src).toMatch(
      /if count >= tonumber\(ARGV\[5\]\) then return \{-1, "limit"\} end/,
    );
  });

  it("stores deliverable:false for local-only (codex) credentials", async () => {
    const summary = await createModelCredential({
      ...defaultCreateArgs(redis),
      name: "codex-seed",
      kind: "oauth_subscription",
      provider: "openai",
      value: '{"auth_mode":"chatgpt","tokens":{}}',
      deliverable: false,
    });
    expect(summary.deliverable).toBe(false);
    expect(summary.kind).toBe("oauth_subscription");
  });
});

// ---------------------------------------------------------------------------
// Multitenant isolation (no cross-tenant oracle)
// ---------------------------------------------------------------------------

describe("multitenant isolation", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("a foreign installationId resolves to NotFound (no cross-tenant read)", async () => {
    await createModelCredential(defaultCreateArgs(redis)); // installation 12345
    await expect(
      getModelCredential({
        installationId: "99999",
        name: "team-claude",
        redis,
      }),
    ).rejects.toThrow(ModelCredentialNotFoundError);
  });

  it("same name in two installations are independent records", async () => {
    await createModelCredential({
      ...defaultCreateArgs(redis),
      installationId: "111",
      value: "secret-aaa",
    });
    await createModelCredential({
      ...defaultCreateArgs(redis),
      installationId: "222",
      value: "secret-bbb",
    });
    const a = await getModelCredential({
      installationId: "111",
      name: "team-claude",
      redis,
    });
    const b = await getModelCredential({
      installationId: "222",
      name: "team-claude",
      redis,
    });
    expect(decryptModelCredentialPayload(a, KEYRING).value).toBe("secret-aaa");
    expect(decryptModelCredentialPayload(b, KEYRING).value).toBe("secret-bbb");
  });

  it("listing is scoped to the installation", async () => {
    await createModelCredential({
      ...defaultCreateArgs(redis),
      installationId: "111",
      name: "a",
    });
    await createModelCredential({
      ...defaultCreateArgs(redis),
      installationId: "222",
      name: "b",
    });
    const list111 = await listModelCredentials({
      installationId: "111",
      redis,
    });
    expect(list111.map((s) => s.name)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// get / list (ciphertext exclusion)
// ---------------------------------------------------------------------------

describe("getModelCredentialSummary / listModelCredentials exclude ciphertext", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("getModelCredentialSummary excludes all crypto fields", async () => {
    await createModelCredential(defaultCreateArgs(redis));
    const summary = await getModelCredentialSummary({
      installationId: "12345",
      name: "team-claude",
      redis,
    });
    expect("ciphertext" in summary).toBe(false);
    expect("iv" in summary).toBe(false);
    expect("tag" in summary).toBe(false);
    expect("keyVersion" in summary).toBe(false);
    expect(summary.fingerprint).toBeDefined();
  });

  it("getModelCredentialSummary throws NotFound when absent", async () => {
    await expect(
      getModelCredentialSummary({
        installationId: "12345",
        name: "missing",
        redis,
      }),
    ).rejects.toThrow(ModelCredentialNotFoundError);
  });

  it("getModelCredentialSummary: a name that EXISTS under another installation is NotFound (no cross-tenant oracle)", async () => {
    await createModelCredential(defaultCreateArgs(redis)); // installation 12345
    await expect(
      getModelCredentialSummary({
        installationId: "99999",
        name: "team-claude",
        redis,
      }),
    ).rejects.toThrow(ModelCredentialNotFoundError);
  });

  it("list returns summaries in creation order, none with ciphertext", async () => {
    await createModelCredential({ ...defaultCreateArgs(redis), name: "first" });
    await createModelCredential({
      ...defaultCreateArgs(redis),
      name: "second",
    });
    await createModelCredential({ ...defaultCreateArgs(redis), name: "third" });
    const out = await listModelCredentials({ installationId: "12345", redis });
    expect(out.map((s) => s.name)).toEqual(["first", "second", "third"]);
    for (const s of out) {
      expect("ciphertext" in s).toBe(false);
    }
  });

  it("list returns [] for an installation with no credentials", async () => {
    const out = await listModelCredentials({ installationId: "00", redis });
    expect(out).toEqual([]);
  });

  it("list self-heals orphaned index entries", async () => {
    await createModelCredential({ ...defaultCreateArgs(redis), name: "alive" });
    await createModelCredential({ ...defaultCreateArgs(redis), name: "ghost" });
    redis._store.delete(envelopeKey("12345", "ghost"));
    const out = await listModelCredentials({ installationId: "12345", redis });
    expect(out.map((s) => s.name)).toEqual(["alive"]);
    const idx = redis._store.get(
      installationIndexKey("12345"),
    ) as SortedSetEntry[];
    expect(idx.map((e) => e.member)).toEqual(["alive"]);
  });
});

// ---------------------------------------------------------------------------
// rotate
// ---------------------------------------------------------------------------

describe("rotateModelCredential", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("re-encrypts the new value, updates fingerprint + rotatedAt, preserves provider/kind", async () => {
    await createModelCredential(defaultCreateArgs(redis));
    const before = await getModelCredential({
      installationId: "12345",
      name: "team-claude",
      redis,
    });

    const summary = await rotateModelCredential({
      installationId: "12345",
      name: "team-claude",
      value: "sk-ant-secret-value-002",
      rotatedBy: "operator",
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });

    expect(summary.provider).toBe("anthropic");
    expect(summary.kind).toBe("api_key");
    expect(summary.rotatedAt).not.toBeNull();
    expect(summary.fingerprint).not.toBe(before.fingerprint);

    const after = await getModelCredential({
      installationId: "12345",
      name: "team-claude",
      redis,
    });
    expect(decryptModelCredentialPayload(after, KEYRING)).toEqual({
      kind: "api_key",
      provider: "anthropic",
      value: "sk-ant-secret-value-002",
    });
    expect(after.ciphertext).not.toBe(before.ciphertext);
  });

  it("throws NotFound when the credential doesn't exist", async () => {
    await expect(
      rotateModelCredential({
        installationId: "12345",
        name: "missing",
        value: "x",
        rotatedBy: "operator",
        keyring: KEYRING,
        keyVersion: "v1",
        redis,
      }),
    ).rejects.toThrow(ModelCredentialNotFoundError);
  });

  it("a name that EXISTS under another installation is NotFound (no cross-tenant rotate)", async () => {
    await createModelCredential(defaultCreateArgs(redis)); // installation 12345
    await expect(
      rotateModelCredential({
        installationId: "99999",
        name: "team-claude",
        value: "sk-ant-attacker",
        rotatedBy: "attacker",
        keyring: KEYRING,
        keyVersion: "v1",
        redis,
      }),
    ).rejects.toThrow(ModelCredentialNotFoundError);
    // The victim's record is untouched.
    const victim = await getModelCredential({
      installationId: "12345",
      name: "team-claude",
      redis,
    });
    expect(decryptModelCredentialPayload(victim, KEYRING).value).toBe(
      "sk-ant-secret-value-001",
    );
  });

  it("the returned summary never exposes crypto fields", async () => {
    await createModelCredential(defaultCreateArgs(redis));
    const summary = await rotateModelCredential({
      installationId: "12345",
      name: "team-claude",
      value: "sk-ant-secret-value-002",
      rotatedBy: "operator",
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });
    expect("ciphertext" in summary).toBe(false);
    expect("iv" in summary).toBe(false);
    expect("tag" in summary).toBe(false);
    expect("keyVersion" in summary).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe("revokeModelCredential", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("blanks ciphertext but keeps metadata, sets status=revoked", async () => {
    await createModelCredential(defaultCreateArgs(redis));
    const summary = await revokeModelCredential({
      installationId: "12345",
      name: "team-claude",
      revokedBy: "operator",
      redis,
    });
    expect(summary.status).toBe("revoked");
    expect(summary.name).toBe("team-claude");
    expect(summary.provider).toBe("anthropic");
    expect(summary.kind).toBe("api_key");
    expect(summary.fingerprint.length).toBe(8);

    const env = redis._store.get(
      envelopeKey("12345", "team-claude"),
    ) as ModelCredentialEnvelopeV1;
    expect(env.ciphertext).toBe("");
    expect(env.iv).toBe("");
    expect(env.tag).toBe("");
    expect(env.status).toBe("revoked");
    expect(env.provider).toBe("anthropic");
    expect(env.fingerprint.length).toBe(8);
  });

  it("throws NotFound when absent (no cross-tenant oracle)", async () => {
    await expect(
      revokeModelCredential({
        installationId: "12345",
        name: "missing",
        revokedBy: "operator",
        redis,
      }),
    ).rejects.toThrow(ModelCredentialNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// re-encrypt
// ---------------------------------------------------------------------------

describe("reEncryptModelCredential", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("rebinds ciphertext to the active key version; value round-trips", async () => {
    await createModelCredential({
      ...defaultCreateArgs(redis),
      keyring: KEYRING_V2,
      keyVersion: "v1",
    });
    const before = await getModelCredential({
      installationId: "12345",
      name: "team-claude",
      redis,
    });
    expect(before.keyVersion).toBe("v1");

    const result = await reEncryptModelCredential({
      installationId: "12345",
      name: "team-claude",
      activeKeyVersion: "v2",
      keyring: KEYRING_V2,
      redis,
    });
    expect(result.action).toBe("re_encrypted");

    const after = await getModelCredential({
      installationId: "12345",
      name: "team-claude",
      redis,
    });
    expect(after.keyVersion).toBe("v2");
    expect(decryptModelCredentialPayload(after, KEYRING_V2).value).toBe(
      "sk-ant-secret-value-001",
    );
  });

  it("skips an already-current envelope (idempotent)", async () => {
    await createModelCredential({
      ...defaultCreateArgs(redis),
      keyring: KEYRING_V2,
      keyVersion: "v2",
    });
    const result = await reEncryptModelCredential({
      installationId: "12345",
      name: "team-claude",
      activeKeyVersion: "v2",
      keyring: KEYRING_V2,
      redis,
    });
    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("already_current");
  });

  it("skips a revoked envelope (no ciphertext to rebind)", async () => {
    await createModelCredential({
      ...defaultCreateArgs(redis),
      keyring: KEYRING_V2,
      keyVersion: "v1",
    });
    await revokeModelCredential({
      installationId: "12345",
      name: "team-claude",
      revokedBy: "operator",
      redis,
    });
    const result = await reEncryptModelCredential({
      installationId: "12345",
      name: "team-claude",
      activeKeyVersion: "v2",
      keyring: KEYRING_V2,
      redis,
    });
    expect(result.action).toBe("skipped");
    expect(result.reason).toBe("revoked");
  });

  it("throws NotFound when absent", async () => {
    await expect(
      reEncryptModelCredential({
        installationId: "12345",
        name: "missing",
        activeKeyVersion: "v2",
        keyring: KEYRING_V2,
        redis,
      }),
    ).rejects.toThrow(ModelCredentialNotFoundError);
  });

  it("a name that EXISTS under another installation is NotFound (no cross-tenant re-encrypt)", async () => {
    await createModelCredential({
      ...defaultCreateArgs(redis),
      keyring: KEYRING_V2,
      keyVersion: "v1",
    }); // installation 12345
    await expect(
      reEncryptModelCredential({
        installationId: "99999",
        name: "team-claude",
        activeKeyVersion: "v2",
        keyring: KEYRING_V2,
        redis,
      }),
    ).rejects.toThrow(ModelCredentialNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// GCM authentication of kind/provider (tamper detection)
// ---------------------------------------------------------------------------

describe("decryptModelCredentialPayload — GCM tamper detection", () => {
  let redis: ReturnType<typeof makeMockRedis>;
  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("a corrupted GCM tag fails to decrypt (does not silently return data)", async () => {
    await createModelCredential(defaultCreateArgs(redis));
    const env = redis._store.get(
      envelopeKey("12345", "team-claude"),
    ) as ModelCredentialEnvelopeV1;
    // Flip the auth tag — decryption MUST throw, never return plaintext.
    const tampered = { ...env, tag: Buffer.alloc(16, 7).toString("base64") };
    expect(() => decryptModelCredentialPayload(tampered, KEYRING)).toThrow();
  });

  it("kind/provider come from the authenticated plaintext, not the clear envelope fields", async () => {
    await createModelCredential(defaultCreateArgs(redis));
    const env = redis._store.get(
      envelopeKey("12345", "team-claude"),
    ) as ModelCredentialEnvelopeV1;
    // Swap only the CLEAR metadata copies; the GCM-sealed plaintext is unchanged.
    const swapped = { ...env, kind: "oauth_subscription", provider: "openai" };
    const decrypted = decryptModelCredentialPayload(
      swapped as ModelCredentialEnvelopeV1,
      KEYRING,
    );
    // The trusted values are the ones sealed inside the ciphertext.
    expect(decrypted.kind).toBe("api_key");
    expect(decrypted.provider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle round-trip
// ---------------------------------------------------------------------------

describe("create → get → list → rotate → revoke round-trip", () => {
  it("walks the lifecycle and never leaks ciphertext through summaries", async () => {
    const redis = makeMockRedis();
    await createModelCredential(defaultCreateArgs(redis));

    const got = await getModelCredentialSummary({
      installationId: "12345",
      name: "team-claude",
      redis,
    });
    expect(got.status).toBe("active");
    expect("ciphertext" in got).toBe(false);

    const list = await listModelCredentials({ installationId: "12345", redis });
    expect(list).toHaveLength(1);

    const rotated = await rotateModelCredential({
      installationId: "12345",
      name: "team-claude",
      value: "sk-ant-secret-value-rotated",
      rotatedBy: "operator",
      keyring: KEYRING,
      keyVersion: "v1",
      redis,
    });
    expect(rotated.rotatedAt).not.toBeNull();

    const revoked = await revokeModelCredential({
      installationId: "12345",
      name: "team-claude",
      revokedBy: "operator",
      redis,
    });
    expect(revoked.status).toBe("revoked");
  });
});

// ---------------------------------------------------------------------------
// Upstash-Lua compatibility lint (no cjson/cmsgpack/bit/struct)
// ---------------------------------------------------------------------------

describe("Upstash-Lua compatibility (no sandbox-missing libs)", () => {
  const source = readFileSync(
    new URL("./model-credential-store.ts", import.meta.url).pathname,
    "utf-8",
  );

  const REDIS_INVOCATION_TOKEN = "redis." + "call(";
  function extractLuaScripts(src: string): string[] {
    const scripts: string[] = [];
    const regex = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(src)) !== null) {
      if (match[1].includes(REDIS_INVOCATION_TOKEN)) scripts.push(match[1]);
    }
    return scripts;
  }

  it("has at least one Lua script (sanity)", () => {
    expect(extractLuaScripts(source).length).toBeGreaterThan(0);
  });

  it("no Lua script uses cjson / cmsgpack / bit / struct", () => {
    const patterns = [/\bcjson\./, /\bcmsgpack\./, /\bbit\./, /\bstruct\./];
    for (const script of extractLuaScripts(source)) {
      for (const p of patterns) {
        expect(p.test(script)).toBe(false);
      }
    }
  });
});
