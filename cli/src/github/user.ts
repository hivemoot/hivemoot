import { gh } from "./client.js";
import { CliError } from "../config/types.js";

/**
 * Return the login of the currently authenticated GitHub user.
 */
export async function fetchCurrentUser(): Promise<string> {
  const login = await gh(["api", "user", "--jq", ".login"]);
  if (!login) {
    throw new CliError(
      "Could not determine GitHub username. Pass --github-token <token>, set GITHUB_TOKEN, or run: gh auth login",
      "GH_NOT_AUTHENTICATED",
      2,
    );
  }
  return login;
}
