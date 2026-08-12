// import Docker from "dockerode";
import { StructuredTool } from "@langchain/core/tools";
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
  "planner" | "coder" | "executor" | "reviewer" | "debugger";

export interface AgentConfig {
  type: AgentType;
  systemPrompt: string;
  tools: StructuredTool[];
}
