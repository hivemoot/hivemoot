import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readRoot(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("ci post-deploy health gate contract", () => {
  const ciWorkflow = readRoot(".github/workflows/ci.yml");

  it("captures deployment URL and exposes it via deploy step output", () => {
    expect(ciWorkflow).toContain("- name: Deploy");
    expect(ciWorkflow).toContain("id: deploy");
    expect(ciWorkflow).toContain('echo "url=$deploy_url" >> "$GITHUB_OUTPUT"');
    expect(ciWorkflow).toContain("Failed to extract deployment URL from Vercel output");
  });

  it("probes webhook health endpoint derived from deployment URL", () => {
    expect(ciWorkflow).toContain('health_url="${{ steps.deploy.outputs.url }}/api/github/webhooks"');
    expect(ciWorkflow).toContain('response="$(curl -fsS --max-time 15 "$health_url")"');
  });

  it("fails closed on critical readiness and warns on degraded llm readiness", () => {
    expect(ciWorkflow).toContain('if [ "$status" != "ok" ] || [ "$github_app_ready" != "true" ]; then');
    expect(ciWorkflow).toContain("::error::Critical health check failed");
    expect(ciWorkflow).toContain("::warning::LLM readiness degraded");
  });

  it("uses bounded retry/backoff and errors when endpoint stays unreachable", () => {
    expect(ciWorkflow).toContain("max_attempts=5");
    expect(ciWorkflow).toContain("sleep_seconds=$((attempt * 5))");
    expect(ciWorkflow).toContain("Health endpoint not ready (attempt ${attempt}/${max_attempts});");
    expect(ciWorkflow).toContain("Deployment health endpoint unreachable after ${max_attempts} attempts");
  });
});
