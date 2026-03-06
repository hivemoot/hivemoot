// Shared client-side task models used by the dashboard task views.
// Keep these aligned with the task store payload shape.
export interface TaskRecord {
  task_id: string;
  status: string;
  prompt: string;
  repos: string[];
  timeout_secs: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  progress?: string;
}

export interface TaskMessage {
  role: "user" | "agent" | "system";
  content: string;
  created_at: string;
}
