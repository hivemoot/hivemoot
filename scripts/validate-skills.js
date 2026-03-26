#!/usr/bin/env node
// Validates that every skill under .agent/skills/ has required frontmatter
// and at least one activation eval fixture.
//
// Exit 0 = all skills valid
// Exit 1 = one or more skills fail validation

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SKILLS_DIR = join(REPO_ROOT, ".agent", "skills");

const REQUIRED_FRONTMATTER = [
  "name",
  "description",
  "when_to_use",
  "when_not_to_use",
  "triggers",
];

let failed = false;

function error(skillPath, message) {
  console.error(`  ERROR  ${relative(REPO_ROOT, skillPath)}: ${message}`);
  failed = true;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  // Minimal YAML key extractor — only checks top-level keys present.
  const block = match[1];
  const keys = new Set();
  for (const line of block.split("\n")) {
    const keyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/);
    if (keyMatch) keys.add(keyMatch[1]);
  }

  // Extract values for scalar fields (handles inline values and YAML block scalars).
  const scalars = {};
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      // Block scalar: collect continuation lines
      const textLines = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith("  ") || lines[j] === "")) {
        textLines.push(lines[j].trim());
        j++;
      }
      scalars[key] = textLines.filter(Boolean).join(" ");
    } else if (rest.length > 0) {
      scalars[key] = rest;
    }
  }

  return { keys, scalars };
}

function hasListEntries(filePath) {
  const content = readFileSync(filePath, "utf8");
  return content.split("\n").some((line) => line.trimStart().startsWith("- "));
}

function validateSkill(skillDir) {
  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    error(skillDir, "missing SKILL.md");
    return;
  }

  const content = readFileSync(skillMd, "utf8");
  const frontmatter = parseFrontmatter(content);

  if (!frontmatter) {
    error(skillMd, "missing YAML frontmatter (expected --- block at top)");
    return;
  }

  for (const field of REQUIRED_FRONTMATTER) {
    if (!frontmatter.keys.has(field)) {
      error(skillMd, `missing required frontmatter field: ${field}`);
    }
  }

  // description must not be a stub
  const desc = frontmatter.scalars.description ?? "";
  if (desc === ">" || desc === "|" || desc.length < 10) {
    error(skillMd, "description is too short or empty");
  }

  // Check for activation evals
  const evalsDir = join(skillDir, "evals");
  const activateFixture = join(evalsDir, "activate.yml");
  if (!existsSync(activateFixture)) {
    error(skillDir, "missing evals/activate.yml — add at least one activation example");
  } else if (!hasListEntries(activateFixture)) {
    error(skillDir, "evals/activate.yml has no entries — add at least one activation example");
  }

  const skipFixture = join(evalsDir, "skip.yml");
  if (!existsSync(skipFixture)) {
    error(skillDir, "missing evals/skip.yml — add at least one negative example");
  } else if (!hasListEntries(skipFixture)) {
    error(skillDir, "evals/skip.yml has no entries — add at least one negative example");
  }
}

// Walk .agent/skills/*
if (!existsSync(SKILLS_DIR)) {
  console.log("No .agent/skills directory found — skipping validation.");
  process.exit(0);
}

const skills = readdirSync(SKILLS_DIR).filter((name) => {
  const p = join(SKILLS_DIR, name);
  return statSync(p).isDirectory();
});

if (skills.length === 0) {
  console.log("No skills found in .agent/skills/.");
  process.exit(0);
}

console.log(`Validating ${skills.length} skill(s)...\n`);

for (const skill of skills) {
  const skillDir = join(SKILLS_DIR, skill);
  console.log(`  checking ${skill}`);
  validateSkill(skillDir);
}

console.log();

if (failed) {
  console.error("Skill validation failed. Fix the errors above.");
  process.exit(1);
} else {
  console.log("All skills valid.");
  process.exit(0);
}
