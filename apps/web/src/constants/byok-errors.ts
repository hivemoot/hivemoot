/**
 * BYOK error code constants shared between server and client code.
 *
 * This file is intentionally free of server-only imports (e.g. next/server)
 * so it can be safely imported from "use client" components as well as from
 * server modules and Edge middleware.
 *
 * Server code should continue to import byokError() from @/server/byok-error.
 * BYOK_ERROR and ByokErrorCode are re-exported from there for convenience.
 */

export const BYOK_ERROR = {
  ACTIVE_KEY_VERSION_UNAVAILABLE: "byok_key_version_unavailable",
  DECRYPT_FAILED: "byok_decrypt_failed",
  ENCRYPTION_CONFIG_INVALID: "byok_encryption_config_invalid",
  ENCRYPTION_NOT_CONFIGURED: "byok_encryption_not_configured",
  INSTALLATION_MISMATCH: "byok_installation_mismatch",
  INVALID_JSON: "byok_invalid_json",
  MISSING_FIELDS: "byok_missing_fields",
  NOT_AUTHENTICATED: "byok_not_authenticated",
  NOT_CONFIGURED: "byok_not_configured",
  PROVIDER_INVALID: "byok_provider_invalid",
  REVOKED: "byok_revoked",
  SERVER_MISCONFIGURATION: "byok_server_misconfiguration",
  SESSION_INVALID: "byok_session_invalid",
  SESSION_STALE: "byok_session_stale",
  SESSION_STORAGE_NOT_CONFIGURED: "byok_session_storage_not_configured",
} as const;

export type ByokErrorCode = (typeof BYOK_ERROR)[keyof typeof BYOK_ERROR];
