import { ChatGoogle } from "@langchain/google";
import type { AgentFlowState, AgentType } from "shared-types/client";
import { Provider } from "shared-types/client";
import { getTools } from "./ToolBuilder";
import type { StructuredTool } from "@langchain/core/tools";
import { createAgent } from "langchain";

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
    return createAgent({
      model: this.llmModel,
      tools: tools as StructuredTool[],
      systemPrompt: systemPrompt as string,
    });
  };
}
