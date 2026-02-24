/**
 * Browser-only cookie utilities.
 *
 * getCookie reads document.cookie by default. Pass a cookie string explicitly
 * (e.g. in tests) to avoid any browser-global dependency. Do not import from
 * server code or Edge middleware — use @/constants/cookies for shared constants.
 */

/**
 * Reads a single cookie value by name.
 * Defaults to document.cookie; pass an explicit string for testability.
 * Returns null if the cookie is absent or the value fails decoding.
 */
export function getCookie(
  name: string,
  cookieString: string = document.cookie,
): string | null {
  try {
    const match = cookieString.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}
