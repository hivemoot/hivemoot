/**
 * Curated skills catalog for the agent registry.
 *
 * This is the single source of truth the dashboard renders as a skills
 * multi-select and that the fleet store validates `skills[]` against. A skill
 * is a CATALOG KEY, never a free-form string — the reconciler resolves a key to
 * a fixed on-disk skill directory, so allowing arbitrary strings here would be a
 * path-traversal vector on the hive. Keep this list in sync with the actual
 * built-in runtime skills (`agent/.../plugins_builtin/hivemoot/skills/`) and the
 * custom apiary skills (`apiary/skills/`).
 *
 * `standard: true` marks a skill that is broadly useful and offered/pre-checked
 * for every agent. `source` records where the skill physically lives so the UI
 * can group built-in vs custom and an operator can reason about availability.
 */

export type SkillSource = "builtin" | "apiary";

export interface SkillCatalogEntry {
  /** Stable catalog key — matches the on-disk skill directory name.
   * Pattern `^[a-z0-9-]+$` (no path separators) is enforced in fleet
   * validation so a skill key can never escape its fixed resolution root. */
  id: string;
  /** Human label for the picker. */
  name: string;
  /** One-line description shown under the checkbox. */
  description: string;
  /** Where the skill physically lives. */
  source: SkillSource;
  /** Standard skills are broadly applicable and surfaced/pre-checked for all. */
  standard: boolean;
}

/**
 * Built-in runtime skills live in the agent image
 * (`plugins_builtin/hivemoot/skills/`) and are available to every agent.
 * Custom apiary skills live in `apiary/skills/` and are bind-mounted on the hive.
 */
export const SKILLS_CATALOG: readonly SkillCatalogEntry[] = [
  // --- Built-in runtime skills (available to all) ---
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Reviews diffs for correctness, style, and project conventions.",
    source: "builtin",
    standard: true,
  },
  {
    id: "dep-auditor",
    name: "Dependency Auditor",
    description: "Audits dependency updates for breakage and supply-chain risk.",
    source: "builtin",
    standard: false,
  },
  {
    id: "pr-hygiene",
    name: "PR Hygiene",
    description: "Checks PRs for linked issues, size, and template compliance.",
    source: "builtin",
    standard: true,
  },
  {
    id: "security-reviewer",
    name: "Security Reviewer",
    description: "Adversarial review for injection, auth, and secret-leak issues.",
    source: "builtin",
    standard: false,
  },
  {
    id: "test-advocate",
    name: "Test Advocate",
    description: "Flags missing test coverage and weak assertions in changes.",
    source: "builtin",
    standard: true,
  },
  // --- Custom apiary skills ---
  {
    id: "architecture-radar",
    name: "Architecture Radar",
    description: "Spots architectural drift and cross-cutting consistency issues.",
    source: "apiary",
    standard: false,
  },
  {
    id: "deep-research",
    name: "Deep Research",
    description: "Methodical multi-source research with adversarial verification.",
    source: "apiary",
    standard: false,
  },
  {
    id: "proposal-architect",
    name: "Proposal Architect",
    description: "Drafts well-scoped governance proposals from raw ideas.",
    source: "apiary",
    standard: false,
  },
  {
    id: "community-relations",
    name: "Community Relations",
    description: "Engages contributors with clear, friendly governance updates.",
    source: "apiary",
    standard: false,
  },
  {
    id: "consistency-propagator",
    name: "Consistency Propagator",
    description: "Propagates a convention across the codebase once it is adopted.",
    source: "apiary",
    standard: false,
  },
  {
    id: "adversarial-tester",
    name: "Adversarial Tester",
    description: "Designs adversarial test cases that try to break a change.",
    source: "apiary",
    standard: false,
  },
  {
    id: "incident-investigator",
    name: "Incident Investigator",
    description: "Roots out the cause of failures from logs and process state.",
    source: "apiary",
    standard: false,
  },
  {
    id: "quality-polish",
    name: "Quality Polish",
    description: "Tightens UX, copy, and rough edges before release.",
    source: "apiary",
    standard: false,
  },
  {
    id: "release-readiness",
    name: "Release Readiness",
    description: "Assesses whether a change set is safe to ship.",
    source: "apiary",
    standard: false,
  },
  {
    id: "user-journey-auditor",
    name: "User Journey Auditor",
    description: "Walks end-to-end user journeys to find broken flows.",
    source: "apiary",
    standard: false,
  },
  {
    id: "workflow-optimizer",
    name: "Workflow Optimizer",
    description: "Improves agent/CI workflows and removes friction.",
    source: "apiary",
    standard: false,
  },
  {
    id: "claim-verifier",
    name: "Claim Verifier",
    description: "Independently verifies claims made in PRs and reviews.",
    source: "apiary",
    standard: false,
  },
] as const;

const SKILL_IDS: ReadonlySet<string> = new Set(SKILLS_CATALOG.map((s) => s.id));

/** True when `id` is a known catalog skill key. */
export function isKnownSkill(id: string): boolean {
  return SKILL_IDS.has(id);
}

/** The catalog keys that are standard (available-to-all / pre-checked). */
export function standardSkillIds(): string[] {
  return SKILLS_CATALOG.filter((s) => s.standard).map((s) => s.id);
}
