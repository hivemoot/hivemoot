export type GroupMode = "repo" | "agent";
export type GroupStatus = "ok" | "failed" | "late" | "unknown";

export interface GroupableAgent {
  agent_id: string;
  repo: string;
  online?: boolean;
  outcome?: "success" | "failure" | "timeout";
  status?: GroupStatus;
}

export interface AgentGroup<TAgent extends GroupableAgent> {
  name: string;
  entries: TAgent[];
  statusCounts: Record<GroupStatus, number>;
  worstStatusPriority: number;
}

const GROUP_STATUS_PRIORITY: Record<GroupStatus, number> = {
  failed: 0,
  late: 1,
  unknown: 2,
  ok: 3,
};

export const GROUP_STATUS_ORDER: GroupStatus[] = [
  "failed",
  "late",
  "unknown",
  "ok",
];

export const GROUP_STATUS_META: Record<
  GroupStatus,
  { label: string; colorClass: string }
> = {
  failed: { label: "failed", colorClass: "bg-red-400" },
  late: { label: "late", colorClass: "bg-amber-400" },
  unknown: { label: "unknown", colorClass: "bg-zinc-500" },
  ok: { label: "ok", colorClass: "bg-green-400" },
};

function makeEmptyStatusCounts(): Record<GroupStatus, number> {
  return { failed: 0, late: 0, unknown: 0, ok: 0 };
}

export function getGroupStatus(agent: GroupableAgent): GroupStatus {
  if (
    agent.status === "ok" ||
    agent.status === "failed" ||
    agent.status === "late" ||
    agent.status === "unknown"
  ) {
    return agent.status;
  }

  if (agent.outcome === "failure" || agent.outcome === "timeout") {
    return "failed";
  }
  if (agent.online === false) return "unknown";
  if (agent.outcome === "success") return "ok";
  if (agent.online === true) return "ok";
  return "unknown";
}

export function buildGroups<TAgent extends GroupableAgent>(
  agents: TAgent[],
  mode: GroupMode,
): AgentGroup<TAgent>[] {
  const groups = new Map<string, AgentGroup<TAgent>>();

  for (const agent of agents) {
    const groupName = mode === "repo" ? agent.repo : agent.agent_id;
    const status = getGroupStatus(agent);
    const statusPriority = GROUP_STATUS_PRIORITY[status];

    let group = groups.get(groupName);
    if (!group) {
      group = {
        name: groupName,
        entries: [],
        statusCounts: makeEmptyStatusCounts(),
        worstStatusPriority: GROUP_STATUS_PRIORITY.ok,
      };
      groups.set(groupName, group);
    }

    group.entries.push(agent);
    group.statusCounts[status] += 1;
    if (statusPriority < group.worstStatusPriority) {
      group.worstStatusPriority = statusPriority;
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) =>
      a.worstStatusPriority - b.worstStatusPriority ||
      a.name.localeCompare(b.name),
  );
}
