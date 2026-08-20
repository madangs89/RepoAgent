import { ChatGoogle } from "@langchain/google";
import type { AgentFlowState, AgentType } from "shared-types/client";
import {
  CoderResponseFormat,
  DebuggerResponseFormat,
  PlannerResponseFormat,
  Provider,
  ReviewerResponseFormat,
  SubmitterResponseFormat,
} from "shared-types/client";
import { getTools } from "./ToolBuilder";
import type { StructuredTool } from "@langchain/core/tools";
import { createAgent, toolStrategy } from "langchain";
import { z } from "zod";

interface BaseAgentRequirements {
  model: string;
  apiKey: string;
  provider: Provider;
}

interface AgentInvokeParams {
  type: AgentType;
  context: AgentFlowState;
}

export class BaseAgent {
  private llmModel: ChatGoogle;
  constructor({
    provider = Provider.GOOGLE,
    model,
    apiKey,
  }: BaseAgentRequirements) {
    if (!model || !apiKey) {
      throw new Error("Please Provide All Details");
    }
    switch (provider) {
      case Provider.GOOGLE:
        this.llmModel = new ChatGoogle({
          model,
          apiKey,
        });
        break;
      default:
        this.llmModel = new ChatGoogle({
          model,
          apiKey,
        });
    }
  }

  public getAgent = (params: AgentInvokeParams) => {
    const { type, context } = params;
    const { tools, systemPrompt } = getTools(type, context);

    let resFormat: any = undefined;

    switch (type) {
      case "planner":
        resFormat = PlannerResponseFormat;
        break;
      case "coder":
        resFormat = CoderResponseFormat;
        break;
      case "reviewer":
        resFormat = ReviewerResponseFormat;
        break;
      case "debugger":
        resFormat = DebuggerResponseFormat;
        break;
      case "submitter":
        resFormat = SubmitterResponseFormat;
        break;
    }

    const agentConfig: any = {};
    if (resFormat) {
      agentConfig.responseFormat = toolStrategy(resFormat);
    }

    return createAgent({
      model: this.llmModel,
      tools: tools as StructuredTool[],
      systemPrompt: systemPrompt as string,
      ...agentConfig,
    });
  };
}
