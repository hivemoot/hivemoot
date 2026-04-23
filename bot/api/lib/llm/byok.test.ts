import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetMasterKeysCache, resolveInstallationBYOKConfig } from "./byok.js";

type EnvelopeOverrides = Partial<{
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: string;
  provider: string;
  model: string;
  status: string;
}>;

function encryptPlaintext(
  plaintext: string,
  masterKey: Buffer,
): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function buildEnvelope(
  payload: unknown,
  masterKey: Buffer,
  overrides: EnvelopeOverrides = {},
): string {
  const plaintext =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  const encrypted = encryptPlaintext(plaintext, masterKey);

  return JSON.stringify({
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    keyVersion: "v1",
    status: "active",
    ...overrides,
  });
}

function setRedisEnv(
  overrides: Record<string, string | undefined> = {},
): void {
  delete process.env.HIVEMOOT_REDIS_REST_URL;
  delete process.env.HIVEMOOT_REDIS_REST_TOKEN;
  delete process.env.BYOK_REDIS_KEY_PREFIX;

  process.env.HIVEMOOT_REDIS_REST_URL = "https://redis.example.com";
  process.env.HIVEMOOT_REDIS_REST_TOKEN = "redis-token";

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setMasterKeys(value: string | Record<string, string>): void {
  process.env.BYOK_MASTER_KEYS =
    typeof value === "string" ? value : JSON.stringify(value);
}

function stubRedisResponse(
  body: Record<string, unknown>,
  options: { ok?: boolean; status?: number } = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe("resolveInstallationBYOKConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
    _resetMasterKeysCache();
  });

  it("returns null when Redis runtime config is blank or missing", async () => {
    process.env.HIVEMOOT_REDIS_REST_URL = "   ";
    process.env.HIVEMOOT_REDIS_REST_TOKEN = "   ";

    await expect(resolveInstallationBYOKConfig(1)).resolves.toBeNull();
  });

  it("throws when only URL is set without token", async () => {
    setRedisEnv({ HIVEMOOT_REDIS_REST_TOKEN: undefined });

    await expect(resolveInstallationBYOKConfig(1)).rejects.toThrow(
      "BYOK Redis runtime is misconfigured",
    );
  });

  it("throws when only token is set without URL", async () => {
    setRedisEnv({ HIVEMOOT_REDIS_REST_URL: undefined });

    await expect(resolveInstallationBYOKConfig(1)).rejects.toThrow(
      "BYOK Redis runtime is misconfigured",
    );
  });

  it("normalizes quoted runtime config and resolves a gemini provider", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv({
      HIVEMOOT_REDIS_REST_URL: " 'https://redis.example.com///' ",
      HIVEMOOT_REDIS_REST_TOKEN: ' "redis-token" ',
      BYOK_REDIS_KEY_PREFIX: " 'custom:byok' ",
    });
    setMasterKeys({ v1: masterKey.toString("hex") });

    const envelope = buildEnvelope(
      { apiKey: "sk-byok", provider: "gemini", model: "  gemini-2.0-flash  " },
      masterKey,
    );
    const fetchMock = stubRedisResponse({ result: envelope });

    const resolved = await resolveInstallationBYOKConfig(99);

    expect(resolved).toEqual({
      apiKey: "sk-byok",
      provider: "google",
      model: "gemini-2.0-flash",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://redis.example.com/get/custom%3Abyok%3A99",
    );
  });

  it("accepts openrouter as a supported BYOK provider", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    stubRedisResponse({
      result: buildEnvelope(
        { apiKey: "sk-openrouter", provider: "openrouter", model: "openai/gpt-4o-mini" },
        masterKey,
      ),
    });

    await expect(resolveInstallationBYOKConfig(99)).resolves.toEqual({
      apiKey: "sk-openrouter",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
    });
  });

  it("throws when Redis request fails", async () => {
    setRedisEnv();
    stubRedisResponse({}, { ok: false, status: 503 });

    await expect(resolveInstallationBYOKConfig(2)).rejects.toThrow(
      "BYOK Redis lookup failed with HTTP 503",
    );
  });

  it("throws when Redis lookup times out", async () => {
    setRedisEnv();
    const abortError = new Error("Request aborted");
    abortError.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch);

    await expect(resolveInstallationBYOKConfig(2)).rejects.toThrow(
      "BYOK Redis lookup timed out after 5000ms",
    );
  });

  it("re-throws non-abort fetch errors as-is", async () => {
    setRedisEnv();
    const networkError = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError) as unknown as typeof fetch);

    await expect(resolveInstallationBYOKConfig(2)).rejects.toThrow("Failed to fetch");
  });

  it("sends Authorization header with Bearer token", async () => {
    setRedisEnv();
    const fetchMock = stubRedisResponse({ result: null });

    await resolveInstallationBYOKConfig(1);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer redis-token",
      }),
    );
  });

  it("throws when Redis REST response is not valid JSON", async () => {
    setRedisEnv();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("Unexpected token"); },
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(resolveInstallationBYOKConfig(2)).rejects.toThrow(
      "BYOK Redis REST response is not valid JSON (HTTP 200)",
    );
  });

  it("throws when Redis returns an explicit error field", async () => {
    setRedisEnv();
    stubRedisResponse({ error: "forbidden", result: null });

    await expect(resolveInstallationBYOKConfig(2)).rejects.toThrow(
      "BYOK Redis returned an error for installation 2",
    );
  });

  it("throws when Redis response omits the result field", async () => {
    setRedisEnv();
    stubRedisResponse({});

    await expect(resolveInstallationBYOKConfig(2)).rejects.toThrow(
      "BYOK Redis response is missing the 'result' field",
    );
  });

  it("throws when Redis returns a non-string result", async () => {
    setRedisEnv();
    stubRedisResponse({ result: 123 });

    await expect(resolveInstallationBYOKConfig(2)).rejects.toThrow(
      "BYOK Redis returned an unexpected result payload",
    );
  });

  it("returns null for revoked BYOK records", async () => {
    setRedisEnv();
    stubRedisResponse({
      result: JSON.stringify({
        ciphertext: "AA==",
        iv: "AA==",
        tag: "AA==",
        keyVersion: "v1",
        status: "revoked",
      }),
    });

    await expect(resolveInstallationBYOKConfig(3)).resolves.toBeNull();
  });

  it("throws for non-active, non-revoked BYOK record status", async () => {
    setRedisEnv();
    stubRedisResponse({
      result: JSON.stringify({
        ciphertext: "AA==",
        iv: "AA==",
        tag: "AA==",
        keyVersion: "v1",
        status: "pending",
      }),
    });

    await expect(resolveInstallationBYOKConfig(3)).rejects.toThrow(
      "BYOK record for installation 3 is not active (status=pending)",
    );
  });

  it("throws when BYOK record status is missing", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    const envelope = JSON.parse(
      buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    ) as Record<string, unknown>;
    delete envelope.status;
    stubRedisResponse({ result: JSON.stringify(envelope) });

    await expect(resolveInstallationBYOKConfig(3)).rejects.toThrow(
      "BYOK record for installation 3 is not active (status=missing)",
    );
  });

  it("throws when BYOK record status is blank", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    stubRedisResponse({
      result: buildEnvelope(
        { apiKey: "sk", provider: "openai" },
        masterKey,
        { status: " " },
      ),
    });

    await expect(resolveInstallationBYOKConfig(3)).rejects.toThrow(
      "BYOK record for installation 3 is not active (status= )",
    );
  });

  it("throws when BYOK master keys are missing", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    delete process.env.BYOK_MASTER_KEYS;
    stubRedisResponse({
      result: buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    });

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK master keys are not configured: set BYOK_MASTER_KEYS",
    );
  });

  it("throws when BYOK master keys are invalid JSON", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys("not-json");
    stubRedisResponse({
      result: buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    });

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK_MASTER_KEYS must be valid JSON",
    );
  });

  it("throws when BYOK master keys are not an object", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys("[]");
    stubRedisResponse({
      result: buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    });

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK_MASTER_KEYS must be a JSON object keyed by keyVersion",
    );
  });

  it("throws when BYOK master key entries are blank", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: "" });
    stubRedisResponse({
      result: buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    });

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK_MASTER_KEYS.v1 must be a non-empty 64-char hex string",
    );
  });

  it("throws when BYOK master key length is invalid", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: randomBytes(16).toString("hex") });
    stubRedisResponse({
      result: buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    });

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK_MASTER_KEYS.v1 must be a 64-char hex string (got 32 chars)",
    );
  });

  it("throws when BYOK master keys object is empty", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({});
    stubRedisResponse({
      result: buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    });

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK_MASTER_KEYS must include at least one key version",
    );
  });

  it("throws when BYOK envelope is not valid JSON", async () => {
    setRedisEnv();
    stubRedisResponse({ result: "not-json" });

    await expect(resolveInstallationBYOKConfig(5)).rejects.toThrow(
      "BYOK envelope is not valid JSON",
    );
  });

  it("throws when BYOK envelope is not an object", async () => {
    setRedisEnv();
    stubRedisResponse({ result: "[]" });

    await expect(resolveInstallationBYOKConfig(5)).rejects.toThrow(
      "BYOK envelope must be a JSON object",
    );
  });

  it("throws when BYOK envelope is missing required fields", async () => {
    setRedisEnv();
    stubRedisResponse({
      result: JSON.stringify({ keyVersion: "v1" }),
    });

    await expect(resolveInstallationBYOKConfig(5)).rejects.toThrow(
      "BYOK envelope is missing required fields",
    );
  });

  it("throws when BYOK envelope fields are invalid base64", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    stubRedisResponse({
      result: buildEnvelope(
        { apiKey: "sk", provider: "openai" },
        masterKey,
        { iv: "" },
      ),
    });

    await expect(resolveInstallationBYOKConfig(6)).rejects.toThrow(
      "BYOK envelope field 'iv' is not valid base64",
    );
  });

  it("throws when BYOK envelope IV is not 12 bytes (rejects 16-byte IV)", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    // Produce an envelope with a 16-byte IV instead of the required 12 bytes.
    // We encrypt the plaintext with the 16-byte IV so the envelope is valid
    // structurally, but decryptEnvelope must reject it before touching crypto.
    const iv16 = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm" as any, masterKey, iv16);
    const payload = { apiKey: "sk", provider: "openai" };
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
      cipher.final(),
    ]);
    const envelope = JSON.stringify({
      ciphertext: ciphertext.toString("base64"),
      iv: iv16.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      keyVersion: "v1",
      status: "active",
    });
    stubRedisResponse({ result: envelope });

    await expect(resolveInstallationBYOKConfig(6)).rejects.toThrow(
      "BYOK envelope IV must be 12 bytes (96 bits) for AES-256-GCM; got 16",
    );
  });

  it("throws when decrypted payload is not valid JSON", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    stubRedisResponse({
      result: buildEnvelope("not-json", masterKey),
    });

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "BYOK decrypted payload is not valid JSON",
    );
  });

  it("throws when decrypted payload is not an object", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    stubRedisResponse({
      result: buildEnvelope(JSON.stringify("string-payload"), masterKey),
    });

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "BYOK decrypted payload must be a JSON object",
    );
  });

  it("throws when decrypted payload is missing apiKey", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    stubRedisResponse({
      result: buildEnvelope({ provider: "openai" }, masterKey),
    });

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "BYOK decrypted payload is missing apiKey",
    );
  });

  it("throws when provider is missing from decrypted payload", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    stubRedisResponse({
      result: buildEnvelope(
        { apiKey: "sk-only" },
        masterKey,
        { provider: "openai", model: "gpt-4o-mini" },
      ),
    });

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "BYOK provider is missing",
    );
  });

  it("ignores unauthenticated envelope model metadata", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    stubRedisResponse({
      result: buildEnvelope(
        { apiKey: "sk", provider: "openai" },
        masterKey,
        { model: "gpt-4o-mini" },
      ),
    });

    await expect(resolveInstallationBYOKConfig(7)).resolves.toEqual({
      apiKey: "sk",
      provider: "openai",
      model: undefined,
    });
  });

  it("throws when provider is unsupported", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    stubRedisResponse({
      result: buildEnvelope({ apiKey: "sk", provider: "vertex" }, masterKey),
    });

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "Unsupported BYOK provider: vertex",
    );
  });

  it("throws when provider is mistral (removed from BYOK allowlist)", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("hex") });
    stubRedisResponse({
      result: buildEnvelope({ apiKey: "sk", provider: "mistral" }, masterKey),
    });

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "Unsupported BYOK provider: mistral",
    );
  });
});
