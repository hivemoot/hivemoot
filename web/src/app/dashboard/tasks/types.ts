// Shared client-side task models used by the dashboard task views.
// Keep these aligned with the task store payload shape.
export type TaskArtifactType =
  | "pull_request"
  | "issue"
  | "issue_comment"
  | "commit";

export interface TaskArtifact {
  type: TaskArtifactType;
  url: string;
  number?: number;
  title?: string;
  created_at: string;
}

export interface TaskRecord {
  task_id: string;
  status: string;
  prompt: string;
  timeout_secs: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  progress?: string;
  artifacts?: TaskArtifact[];
}

export interface TaskMessage {
  role: "user" | "agent" | "system";
  content: string;
  created_at: string;
}
