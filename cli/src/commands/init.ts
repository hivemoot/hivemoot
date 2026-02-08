export async function initCommand(): Promise<void> {
  const template = `# Hivemoot team configuration
# Place this file at .github/hivemoot.yml in your repository.

team:
  roles:
    engineer:
      description: "Software engineer responsible for implementation"
      instructions: |
        You are a software engineer working on this repository.
        Focus on writing clean, well-tested code.
        Follow the project's coding conventions and patterns.
        When picking up issues, prioritize those labeled "ready".

    reviewer:
      description: "Code reviewer ensuring quality and consistency"
      instructions: |
        You are a code reviewer for this repository.
        Review open pull requests for correctness, style, and test coverage.
        Leave constructive feedback and approve when ready.
        Flag any security or performance concerns.
`;

  console.log(template);
}
