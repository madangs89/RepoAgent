import {
  CoderResponse,
  DebuggerResponse,
  PlannerResponse,
  Provider,
  ReviewerResponse,
  Status,
  SubmitterResponse,
  type AgentType,
} from "shared-types/client";
import { BaseAgent } from "../agent/agentBody";
import { GraphState } from "../agentState/stateManagement";
import { HumanMessage } from "langchain";
import { BaseAgentMemory } from "..";
import axios from "axios";
import { END, START, StateGraph } from "@langchain/langgraph";

const getGoogleApiKey = (type: AgentType) => {
  const envMap: Record<AgentType, string> = {
    planner: "PLANNER_GOOGLE_API_KEY",
    coder: "CODER_GOOGLE_API_KEY",
    reviewer: "REVIEWER_GOOGLE_API_KEY",
    debugger: "DEBUGGER_GOOGLE_API_KEY",
    submitter: "SUBMITTER_GOOGLE_API_KEY",
  };

  const apiKey =
    process.env[envMap[type]] ??
    process.env.GOOGLE_API_KEY ??
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      `Missing ${envMap[type]} or GOOGLE_API_KEY or GEMINI_API_KEY environment variable`,
    );
  }

  return apiKey;
};

const plannerNode = async (state: typeof GraphState.State) => {
  const agent = new BaseAgent({
    apiKey: getGoogleApiKey("planner"),
    model: "gemini-2.5-flash",
    provider: Provider.GOOGLE,
  });

  const plannerAgent = agent.getAgent({
    type: "planner",
    context: {
      containerId: state.containerId,
      sandboxUrl: state.sandboxUrl,
      repoPath: "/workspace/repo",
      issueId: "123",
    },
  });

  console.log("Planner Agent created");
  const result = await plannerAgent.invoke({
    messages: [new HumanMessage(state.issue)],
  });

  result.messages.forEach((message) => {
    console.log("Planner Agent message:", message);
  });

  console.log("final result from planner agent:", result.structuredResponse);
  const finalMessage = PlannerResponse.safeParse(result.structuredResponse);

  if (!finalMessage.success) {
    console.error("Failed to parse planner response:", finalMessage.error);
    throw new Error("Failed to parse planner response");
  }

  console.log("Final Message from Planner Agent:", finalMessage.data);

  const plan = finalMessage.data.steps.map((s, index) => {
    return {
      id: index.toString(),
      plan: s,
      status: Status.PENDING,
    };
  });

  console.log("Plan to be added to config:", plan);
  await Promise.all([
    await BaseAgentMemory.addPlanToConfig(state.containerId, plan),
    await BaseAgentMemory.addKeyValueToConfig(
      state.containerId,
      "root_cause",
      finalMessage.data.root_cause,
    ),
    await BaseAgentMemory.addKeyValueToConfig(
      state.containerId,
      "files_to_change",
      finalMessage.data.files_to_change,
    ),
  ]);

  return {
    plan,
    root_cause: finalMessage.data.root_cause,
    files_to_change: finalMessage.data.files_to_change,
  };
};

const coderNode = async (state: typeof GraphState.State) => {
  const agent = new BaseAgent({
    apiKey: getGoogleApiKey("coder"),
    model: "gemini-2.5-flash",
    provider: Provider.GOOGLE,
  });

  const coderAgent = agent.getAgent({
    type: "coder",
    context: {
      containerId: state.containerId,
      sandboxUrl: state.sandboxUrl,
      repoPath: "/workspace/repo",
      issueId: "123",
    },
  });

  console.log("Coder Agent created");
  const coderResult = await coderAgent.invoke({
    messages: [
      new HumanMessage(
        `Plan:\n${state.plan.map((p) => p.plan).join("\n")} \n\nRoot Cause:\n${state.root_cause}\n\nFiles to Change:\n${state.files_to_change.map((f) => `${f.file_path}: ${f.change_description}`).join("\n")}`,
      ),
    ],
  });

  const finalCoderMessage = CoderResponse.safeParse(
    coderResult.structuredResponse,
  );

  if (!finalCoderMessage.success) {
    console.error("Failed to parse coder response:", finalCoderMessage.error);
    throw new Error("Failed to parse coder response");
  }

  await Promise.all([
    await BaseAgentMemory.addKeyValueToConfig(
      state.containerId,
      " coder_output",
      finalCoderMessage.data,
    ),
  ]);

  return {
    coder_output: finalCoderMessage.data,
  };
};
const reviewerNode = async (state: typeof GraphState.State) => {
  const agent = new BaseAgent({
    apiKey: getGoogleApiKey("reviewer"),
    model: "gemini-2.5-flash",
    provider: Provider.GOOGLE,
  });

  const reviewerAgent = agent.getAgent({
    type: "reviewer",
    context: {
      containerId: state.containerId,
      sandboxUrl: state.sandboxUrl,
      repoPath: "/workspace/repo",
      issueId: "123",
    },
  });

  console.log("Reviewer Agent created");
  const reviewerResult = await reviewerAgent.invoke({
    messages: [
      new HumanMessage(`

        Review the changes for this issue:\n${state.issue}\n\n
        Root Cause:\n${state.root_cause}\n\n
        Coder Output:\n${JSON.stringify(state.coder_output)}
        
        
        `),
    ],
  });

  const finalReviewerMessage = ReviewerResponse.safeParse(
    reviewerResult.structuredResponse,
  );

  if (!finalReviewerMessage.success) {
    console.error(
      "Failed to parse reviewer response:",
      finalReviewerMessage.error,
    );
    throw new Error("Failed to parse reviewer response");
  }

  await Promise.all([
    await BaseAgentMemory.addKeyValueToConfig(
      state.containerId,
      "reviewer_output",
      finalReviewerMessage.data,
    ),
  ]);

  return {
    reviewFeedback: finalReviewerMessage.data.feedback,
    reviewVerdict: finalReviewerMessage.data.verdict,
    reviewNote: finalReviewerMessage.data.note,
    iterationCount: state.iterationCount + 1,
  };
};
const debuggerNode = async (state: typeof GraphState.State) => {
  const agent = new BaseAgent({
    apiKey: getGoogleApiKey("debugger"),
    model: "gemini-2.5-flash",
    provider: Provider.GOOGLE,
  });

  const debuggerAgent = agent.getAgent({
    type: "debugger",
    context: {
      containerId: state.containerId,
      sandboxUrl: state.sandboxUrl,
      repoPath: "/workspace/repo",
      issueId: "123",
    },
  });

  console.log("Debugger Agent created");
  const debuggerResult = await debuggerAgent.invoke({
    messages: [
      new HumanMessage(`
          Reviewer found this issue:\n${state.reviewFeedback}\n\nDiagnose and fix it.      
        `),
    ],
  });

  const finalDebuggerMessage = DebuggerResponse.safeParse(
    debuggerResult.structuredResponse,
  );

  if (!finalDebuggerMessage.success) {
    console.error(
      "Failed to parse debugger response:",
      finalDebuggerMessage.error,
    );
    throw new Error("Failed to parse debugger response");
  }

  await Promise.all([
    await BaseAgentMemory.addKeyValueToConfig(
      state.containerId,
      "debugger_output",
      finalDebuggerMessage.data,
    ),
  ]);

  return {
    debugger_output: finalDebuggerMessage.data,
  };
};
const submitterNode = async (state: typeof GraphState.State) => {
  const agent = new BaseAgent({
    apiKey: getGoogleApiKey("submitter"),
    model: "gemini-2.5-flash",
    provider: Provider.GOOGLE,
  });

  const submitterAgent = agent.getAgent({
    type: "submitter",
    context: {
      containerId: state.containerId,
      sandboxUrl: state.sandboxUrl,
      repoPath: "/workspace/repo",
      issueId: "123",
    },
  });

  console.log("Submitter Agent created");
  const submitterResult = await submitterAgent.invoke({
    messages: [
      new HumanMessage(`
          Reviewer found this issue:\n${state.reviewFeedback}\n\nDiagnose and fix it.      
        `),
    ],
  });

  const finalSubmitterMessage = SubmitterResponse.safeParse(
    submitterResult.structuredResponse,
  );

  if (!finalSubmitterMessage.success) {
    console.error(
      "Failed to parse submitter response:",
      finalSubmitterMessage.error,
    );
    throw new Error("Failed to parse submitter response");
  }

  await Promise.all([
    await BaseAgentMemory.addKeyValueToConfig(
      state.containerId,
      "submitter_output",
      finalSubmitterMessage.data,
    ),
  ]);

  return {
    submitter_output: finalSubmitterMessage.data,
  };
};

async function cleanupNode(state: typeof GraphState.State) {
  await axios.post(`${state.sandboxUrl}/end-sandbox`, {
    container_id: state.containerId,
  });
  return {};
}

function routeAfterReview(state: typeof GraphState.State) {
  if (state.reviewVerdict === "pass") return "submitter";
  if (state.iterationCount >= state.maxIterations) return "cleanup"; // give up, don't loop forever
  return "debugger";
}

export const graph = new StateGraph(GraphState)
  .addNode("planner", plannerNode)
  .addNode("coder", coderNode)
  .addNode("reviewer", reviewerNode)
  .addNode("debugger", debuggerNode)
  .addNode("submitter", submitterNode)
  .addNode("cleanup", cleanupNode)
  .addEdge(START, "planner")
  .addEdge("planner", "coder")
  .addEdge("coder", "reviewer")
  .addConditionalEdges("reviewer", routeAfterReview, {
    submitter: "submitter",
    debugger: "debugger",
    cleanup: "cleanup",
  })
  .addEdge("debugger", "reviewer") // loop back to review, not straight to submit
  .addEdge("submitter", "cleanup")
  .addEdge("cleanup", END)
  .compile();
