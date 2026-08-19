import { Annotation } from "@langchain/langgraph";
import type { CoderResponse, Status } from "shared-types/client";
import z from "zod";

export const GraphState = Annotation.Root({
  // Repository / execution context
  containerId: Annotation<string>(),
  sandboxUrl: Annotation<string>(),
  repoPath: Annotation<string>(),

  // Issue
  issueId: Annotation<string>(),
  issue: Annotation<string>(),

  // Agent outputs
  plan: Annotation<
    {
      id: string;
      plan: string;
      status: Status;
    }[]
  >(),
  codeChanges: Annotation<string>(),
  reviewFeedback: Annotation<string>(),
  reviewVerdict: Annotation<"pass" | "fail" | null>,
  iterationCount: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
  maxIterations: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 10,
  }),
  root_cause: Annotation<string>(),
  files_to_change:
    Annotation<{ file_path: string; change_description: string }[]>(),
  coder_output: Annotation<z.infer<typeof CoderResponse>>(),
});
