import { CliError } from "../config/types.js";

/**
 * Reject GitHub App installation tokens (`ghs_*`) for commands that
 * depend on user-scoped GitHub APIs (`/notifications`, `/user`, etc.).
 *
 * App installation tokens authenticate as the GitHub App rather than
 * a user, so any endpoint scoped to "the authenticated user" returns
 * `403 Resource not accessible by integration`. The downstream error
 * is misleading — a token-validity-shaped error message for what is
 * actually an API-incompatibility problem — so commands that touch
 * these endpoints check for the prefix here and fail fast with an
 * actionable message instead.
 *
 * Used by:
 *   - `hivemoot watch`        (polls `/notifications`)
 *   - `hivemoot notifications-pull`  (lists `/notifications`)
 *   - `hivemoot ack`          (PATCHes `/notifications/threads/:id`)
 *
 * `ghp_` (classic PAT), `gho_` (OAuth user-to-server), `ghu_` (server-
 * to-user), `ghr_` (refresh) all stay user-scoped and remain valid for
 * `/notifications` — only `ghs_` is rejected.
 *
 * Architectural rationale lives in `apiarist/DESIGN.md` §12.3.7. The
 * routing-layer alternatives (bot-mediated dispatch via the task queue,
 * label-based polling) handle the use case App tokens can't cover.
 */
export function rejectAppInstallationToken(commandName: string): void {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  if (token.startsWith("ghs_")) {
    throw new CliError(
      `App installation tokens (ghs_*) cannot access GitHub's ` +
        `/notifications API and so cannot be used with \`hivemoot ${commandName}\`. ` +
        `For App-token-compatible PR watching use the \`watch_new_prs\` ` +
        `trigger (polls /repos/{owner}/{repo}/pulls directly). ` +
        `Mention-based or review-request workflows for App tokens need ` +
        `a routing layer (bot-mediated dispatch via the task queue, or ` +
        `label-based polling) since all App-authed agents share the ` +
        `single bot identity. See apiarist/DESIGN.md §12.3.7 for the ` +
        `architectural rationale.`,
      "GH_APP_TOKEN_UNSUPPORTED",
      2,
    );
  }
}
