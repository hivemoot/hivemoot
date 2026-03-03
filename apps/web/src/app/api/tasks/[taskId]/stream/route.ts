import { NextRequest } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { TASK_ERROR, taskError } from "@/server/task-error";
import { extractTaskId } from "@/server/task-route-utils";
import { getTask, TASK_ID_PATTERN, type TaskRecord } from "@/server/task-store";

export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_STREAM_DURATION_MS = 55_000;

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isTerminal(status: TaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "timed_out";
}

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const taskId = extractTaskId(pathname);

  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return taskError(TASK_ERROR.INVALID_TASK_ID, "Invalid task id", 400);
  }

  const initialTask = await getTask(auth.session.installationId, taskId, auth.redis);
  if (!initialTask) {
    return taskError(TASK_ERROR.TASK_NOT_FOUND, "Task not found", 404);
  }

  const installationId = auth.session.installationId;
  const redis = auth.redis;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const streamStartedAt = Date.now();
      let closed = false;
      let lastTaskHash = JSON.stringify(initialTask);
      let lastHeartbeatAt = Date.now();

      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      const sendHeartbeat = () => {
        if (closed) return;
        controller.enqueue(encoder.encode(`: heartbeat\n\n`));
      };

      const abortHandler = () => {
        close();
      };

      request.signal.addEventListener("abort", abortHandler, { once: true });

      const poll = async () => {
        if (closed) return;

        try {
          const currentTask = await getTask(installationId, taskId, redis);
          if (!currentTask) {
            send("error", {
              code: TASK_ERROR.TASK_NOT_FOUND,
              message: "Task not found",
            });
            close();
            return;
          }

          const serialized = JSON.stringify(currentTask);
          if (serialized !== lastTaskHash) {
            send("task", { task: currentTask });
            lastTaskHash = serialized;
          }

          const now = Date.now();
          if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
            sendHeartbeat();
            lastHeartbeatAt = now;
          }

          if (isTerminal(currentTask.status)) {
            send("done", { task: currentTask });
            close();
            return;
          }

          if (now - streamStartedAt >= MAX_STREAM_DURATION_MS) {
            close();
            return;
          }

          setTimeout(poll, POLL_INTERVAL_MS);
        } catch (error) {
          send("error", {
            code: TASK_ERROR.SERVER_ERROR,
            message: "Task stream failed",
          });
          console.error("[tasks] Task stream polling failed", {
            installationId,
            taskId,
            error,
          });
          close();
        }
      };

      send("snapshot", { task: initialTask });
      if (isTerminal(initialTask.status)) {
        send("done", { task: initialTask });
        close();
        return;
      }

      setTimeout(poll, POLL_INTERVAL_MS);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
