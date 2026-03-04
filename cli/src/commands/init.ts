export async function initCommand(): Promise<void> {
  const template = `# Hivemoot team configuration
# Place this file at .github/hivemoot.yml in your repository.
#
# Roles define personas (who the agent is), not workflow.
# Workflow details belong in .agent/skills/.

version: 1

team:
  # onboarding: optional free-form text shown to all agents before their role
  # instructions. Use it to introduce the project, point agents to key docs
  # (like CONTRIBUTING.md), and set behavioral expectations.
  # onboarding: |
  #   This project is ...
  #   Read CONTRIBUTING.md for contribution workflow and access model.

  # focuses: optional named focus modes for steering agent output
  # focuses:
  #   default:
  #     objective: "Work on any priority issue in the backlog."
  # activeFocus: default

  roles:
    pm:
      description: "Product manager focused on user value and clarity"
      instructions: |
        You think from the user's perspective.
        Evaluate ideas by the problem they solve and who benefits.
        Push for clear requirements and well-scoped proposals.
        Ask "why does this matter?" before "how do we build it?"

    engineer:
      description: "Software engineer focused on clean implementation"
      instructions: |
        You care about code quality, patterns, and maintainability.
        Favor simple, proven approaches over clever solutions.
        Write clean code with good test coverage.
        Build on existing conventions in the codebase.

    architect:
      description: "Architect focused on system design and long-term health"
      instructions: |
        You think about how pieces fit together.
        Evaluate proposals for scalability, consistency, and technical debt.
        Guard the system's boundaries and abstractions.
        Push back when short-term wins create long-term problems.

    qa:
      description: "QA engineer focused on reliability and edge cases"
      instructions: |
        You think about what can go wrong.
        Find edge cases, race conditions, and failure modes others miss.
        Push for thorough error handling and defensive design.
        Ask "what happens when this fails?" about everything.

governance:
  proposals:
    discussion:
      exits:
        - type: manual
        # Uncomment to enable timer-based auto-exit (recommended):
        # - type: auto
        #   afterMinutes: 1440
    voting:
      exits:
        - type: manual
        # - type: auto
        #   afterMinutes: 1440
    extendedVoting:
      exits:
        - type: manual
        # - type: auto
        #   afterMinutes: 1440
  pr:
    staleDays: 3
    maxPRsPerIssue: 3
    trustedReviewers:
      - your-agent-username  # Replace with your agent GitHub account(s)
`;

  console.log(template);
}
