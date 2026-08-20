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
  "planner" | "coder" | "reviewer" | "debugger" | "submitter";

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

// Response format for the coder agent
export const CoderResponse = z.object({
  changes_made: z.array(
    z.object({
      file_path: z.string(),
      change_description: z.string(),
    }),
  ),
  deviations_from_plan: z.array(z.string()).default([]),
  notes_for_reviewer: z.string().default(""),
});

export const CoderResponseFormat = {
  type: "object",
  properties: {
    changes_made: {
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
    deviations_from_plan: {
      type: "array",
      items: { type: "string" },
    },
    notes_for_reviewer: { type: "string" },
  },
  required: ["changes_made", "deviations_from_plan", "notes_for_reviewer"],
};

export const ReviewerResponse = z.object({
  feedback: z.string(),
  verdict: z.enum(["pass", "fail"]),
  note: z.string().optional(),
});

export const ReviewerResponseFormat = {
  type: "object",
  properties: {
    feedback: { type: "string" },
    verdict: { type: "string", enum: ["pass", "fail"] },
    note: { type: "string" },
  },
  required: ["feedback", "verdict"],
};

export const DebuggerResponse = z.object({
  root_cause: z.string(),
  fix_applied: z.array(
    z.object({
      file_path: z.string(),
      change_description: z.string(),
    }),
  ),
  reproduced_before_fix: z.boolean(),
  verified_after_fix: z.boolean(),
  notes_for_reviewer: z.string().optional(),
});

export const DebuggerResponseFormat = {
  type: "object",
  properties: {
    root_cause: { type: "string" },
    fix_applied: {
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
    reproduced_before_fix: { type: "boolean" },
    verified_after_fix: { type: "boolean" },

    notes_for_reviewer: { type: "string"},
  },
  required: [
    "root_cause",
    "fix_applied",
    "reproduced_before_fix",
    "verified_after_fix",
  ],
};

export const SubmitterResponse = z.object({
  committed: z.boolean(),
  commit_message: z.string().optional(),
  notes: z.string().optional(),
});

export const SubmitterResponseFormat = {
  type: "object",
  properties: {
    committed: { type: "boolean" },
    commit_message: { type: "string"},
    notes: { type: "string" },
  },
  required: ["committed"],
};
