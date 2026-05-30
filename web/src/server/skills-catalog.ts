/**
 * Curated skills catalog for the agent registry.
 *
 * SCOPE: this lists ONLY the *universal* skills baked into the agent runtime
 * image (`agent/.../plugins_builtin/hivemoot/skills/`), which every agent has
 * regardless of which tenant/installation runs it. It deliberately does NOT
 * include deployment-specific custom skills (e.g. an org's private `apiary/skills/`
 * bind-mount): hivemoot.dev is a multitenant product and must not hardcode any
 * single org's private skills — another tenant would see skills their deployment
 * can't load. Per-deployment custom skills are a future feature (operator-supplied
 * names sourced from their own deployment), tracked separately.
 *
 * A skill is a CATALOG KEY, never a free-form string — the reconciler resolves a
 * key to a fixed on-disk skill directory, so the fleet store validates `skills[]`
 * against this catalog (membership + `^[a-z0-9-]+$`), closing path traversal.
 */

export type SkillSource = "builtin";

export interface SkillCatalogEntry {
  /** Stable catalog key — matches the on-disk skill directory name in the image. */
  id: string;
  name: string;
  description: string;
  /** Always "builtin" today — universal, image-baked. */
  source: SkillSource;
  /** Standard skills are broadly applicable and surfaced/pre-checked for all. */
  standard: boolean;
}

/**
 * Universal built-in runtime skills (`plugins_builtin/hivemoot/skills/`) —
 * available to every agent on every installation.
 */
export const SKILLS_CATALOG: readonly SkillCatalogEntry[] = [
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
