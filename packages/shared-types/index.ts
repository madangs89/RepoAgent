// import Docker from "dockerode";
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export enum Provider {
  GOOGLE = "google",
  OPENAI = "openai",
  ANTHROPIC = "anthropic",
}

export enum Status {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  FAILED = "failed",
}

export interface AgentFlowState {
  containerId: string;
  sandboxUrl: string;
  repoPath: string;
  issueId?: string;
}

export type AgentType =
  "planner" | "coder" | "reviewer" | "debugger";

export interface AgentConfig {
  type: AgentType;
  systemPrompt: string;
  tools: StructuredTool[];
}

// Response format for the planner agent
export const PlannerResponse = z.object({
  root_cause: z.string(),
  files_to_change: z.array(
    z.object({
      file_path: z.string(),
      change_description: z.string(),
    }),
  ),
  steps: z.array(z.string()),
});

export const PlannerResponseFormat = {
  type: "object",
  properties: {
    root_cause: { type: "string" },
    files_to_change: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          change_description: { type: "string" },
        },
        required: ["file_path", "change_description"],
      },
    },
    steps: { type: "array", items: { type: "string" } },
  },
  required: ["root_cause", "files_to_change", "steps"],
};
