import {
  CoderResponse,
  PlannerResponse,
  Provider,
  Status,
} from "shared-types/client";
import { BaseAgent } from "../agent/agentBody";
import type { GraphState } from "../agentState/stateManagement";
import { HumanMessage } from "langchain";
import { BaseAgentMemory } from "..";

const plannerNode = async (state: typeof GraphState.State) => {
  const agent = new BaseAgent({
    apiKey: process.env.GOOGLE_API_KEY!,
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
    apiKey: process.env.GOOGLE_API_KEY!,
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

  return {
    coder_output: finalCoderMessage.data,
  };
};
