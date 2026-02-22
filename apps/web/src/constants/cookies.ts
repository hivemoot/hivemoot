/**
 * Cookie name constants shared between server code and Edge middleware.
 *
 * This file is intentionally free of Node.js built-ins and Redis imports
 * so it can be safely imported from Next.js Edge middleware, which runs
 * outside the Node.js runtime.
 */

/** Cookie name for the short-lived setup session token. */
export const SETUP_SESSION_COOKIE = "setup_session";

/** Browser binding cookie for OAuth state CSRF protection. */
export const OAUTH_STATE_BINDING_COOKIE = "oauth_state_binding";
