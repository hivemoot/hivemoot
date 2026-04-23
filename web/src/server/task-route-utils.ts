export function extractTaskId(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const tasksIndex = parts.lastIndexOf("tasks");
  if (tasksIndex === -1) return null;
  return parts[tasksIndex + 1] ?? null;
}
