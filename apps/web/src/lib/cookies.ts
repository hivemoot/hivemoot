/**
 * Browser-only cookie utilities.
 *
 * This file reads document.cookie and must only be imported from client
 * components (or after hydration via useEffect). Do not import from server
 * code or Edge middleware — use @/constants/cookies for shared constants.
 */

/**
 * Reads a single cookie value by name from document.cookie.
 * Returns null if the cookie is absent or the value fails decoding.
 */
export function getCookie(name: string): string | null {
  try {
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${name}=([^;]*)`),
    );
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}
