import { Annotation } from "@langchain/langgraph";

const GraphState = Annotation.Root({
  // Repository / execution context
  containerId: Annotation<string>(),
  sandboxUrl: Annotation<string>(),
  repoPath: Annotation<string>(),

  // Issue
  issueId: Annotation<string>(),
  issue: Annotation<string>(),

  // Agent outputs
  plan: Annotation<string>(),
  codeChanges: Annotation<string>(),
  reviewFeedback: Annotation<string>(),
  approved: Annotation<boolean>(),
});
