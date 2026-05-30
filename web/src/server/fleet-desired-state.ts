/**
 * Pure builder for the `GET /api/fleet/desired-state` wire contract — the
 * interface between the backend and the on-prem reconciler.
 *
 * Invariants the reconciler relies on (and the contract test asserts):
 *   - DISABLED agents are LISTED (so the sidecar stops their container);
 *   - DELETED agents are ABSENT (so the sidecar deprovisions);
 *   - the response carries NO secrets — only a token NAME, never a bearer
 *     value, provider key, or App key;
 *   - the engine descriptor is fully resolved so the sidecar needs neither
 *     `apiary.yaml` nor `apiary.engines.yaml`.
 */

import { createHash } from "node:crypto";
import { ENGINE_CATALOG, resolveEngine, type ResolvedEngine } from "@/server/engine-catalog";
import type { FleetPlugins, FleetAgent } from "@/server/fleet-store";

// v2: the canonical agent shape is `plugins` (was top-level `repos` + `triggers`
// in v1). Bumping this busts every reconciler's cached ETag on deploy.
export const DESIRED_STATE_CONTRACT_VERSION = 2;

// Short content hash of the engine catalog. Folded into the ETag so a DEPLOY
// that changes engine resolution (e.g. bumps a model or tool_options) — which
// does NOT bump any agent's rosterVersion — still invalidates cached ETags and
// forces the reconciler to re-fetch and re-render. Without this a reconciler
// could serve a stale engine descriptor indefinitely after such a deploy.
const ENGINE_CATALOG_HASH = createHash("sha256")
  .update(JSON.stringify(ENGINE_CATALOG))
  .digest("hex")
  .slice(0, 8);

export interface DesiredStateAgent {
  name: string;
  /** Paused agents stay listed with enabled:false so the sidecar stops them. */
  enabled: boolean;
  managed: boolean;
  config_version: number;
  engine: ResolvedEngine;
  skills: string[];
  system_prompt: string;
  /** The canonical plugin config — `repos` live ONLY under `plugins.github`.
   * Only ENABLED plugin blocks are projected here; disabled ones are dropped
   * (see `projectEnabledPlugins`), so an absent key means "not enabled". */
  plugins: FleetPlugins;
  /** Token NAME + role only — the sidecar resolves the bearer VALUE from its
   * own local secret store; the bearer is never returned over the wire. */
  token: { name: string; agent_role: string };
}

export interface DesiredState {
  version: number;
  etag: string;
  generated_at: string;
  agents: DesiredStateAgent[];
}

export function rosterEtag(rosterVersion: number): string {
  // Every input that can change the response body participates: the per-tenant
  // roster mutation counter, the wire contract version, and the engine catalog.
  return `roster-v${rosterVersion}-c${DESIRED_STATE_CONTRACT_VERSION}-e${ENGINE_CATALOG_HASH}`;
}

/**
 * Project an agent's stored plugins down to ONLY the enabled ones for the wire
 * contract. The registry stores disabled blocks for round-trip editing (the
 * dashboard form re-shows them), but a disabled block carries zero operational
 * information: the reconciler only ACTS on enabled plugins. Shipping it anyway
 * couples the two sides — apiarist's `_parse_plugins` treats every plugin key as
 * optional (absent ⇒ not configured), and `_parse_github_plugin` would parse a
 * present `{enabled:false}` block, so a future apiarist that validated a present
 * block unconditionally could fail-close the whole roster on a block that means
 * nothing. Omitting it is exactly equivalent to never having configured the
 * plugin (apiarist's `None` branch). The store still keeps disabled blocks; only
 * this PROJECTION drops them. The store guarantees ≥1 enabled plugin per agent,
 * so this never empties a real roster — but an empty object is a valid result.
 */
function projectEnabledPlugins(plugins: FleetPlugins): FleetPlugins {
  const out: FleetPlugins = {};
  if (plugins.github?.enabled) out.github = plugins.github;
  if (plugins.schedule?.enabled) out.schedule = plugins.schedule;
  if (plugins.tasks?.enabled) out.tasks = plugins.tasks;
  if (plugins.war_rooms?.enabled) out.war_rooms = plugins.war_rooms;
  return out;
}

/**
 * Build the desired-state payload for one installation's roster. `generatedAt`
 * is injected so the builder stays pure/testable (no Date.now()).
 */
export function buildDesiredState(args: {
  agents: FleetAgent[];
  rosterVersion: number;
  generatedAt: string;
}): DesiredState {
  const agents: DesiredStateAgent[] = args.agents
    // Only agents the reconciler should manage. Disabled stays (sidecar stops
    // it); only `managed:false` (legacy/observe-only) is excluded.
    .filter((a) => a.managed)
    .map((a) => {
      const engine =
        resolveEngine(a.engine) ?? {
          id: a.engine,
          tool: a.engine,
          provider: null,
          model: null,
          tool_options: null,
        };
      return {
        name: a.name,
        enabled: a.enabled,
        managed: a.managed,
        config_version: a.config_version,
        engine,
        skills: a.skills,
        system_prompt: a.system_prompt,
        // Ship only ENABLED plugin blocks; disabled blocks carry no information
        // and a present-but-disabled block needlessly couples us to the reconciler.
        plugins: projectEnabledPlugins(a.plugins),
        token: { name: a.agent_token_name, agent_role: a.name },
      };
    });

  return {
    version: DESIRED_STATE_CONTRACT_VERSION,
    etag: rosterEtag(args.rosterVersion),
    generated_at: args.generatedAt,
    agents,
  };
}
