import TaskDetail from "./TaskDetail";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  return <TaskDetail taskId={taskId} />;
}
