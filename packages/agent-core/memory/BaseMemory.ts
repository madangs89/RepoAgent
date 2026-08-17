import Redis from "ioredis";
import type { AgentType, Status } from "shared-types/client";

const MAX_BUFFER_THRESHOLD = 30;
const KEEP_BUFFER_COUNT = 20;
export class BaseMemoryAgentMemory {
  private redisClient: Redis;

  constructor(redisClient: Redis) {
    this.redisClient = redisClient;
  }
  public addConfig = async ({
    containerId,
    sandboxUrl,
    repoPath,
    issue,
  }: {
    containerId: string;
    sandboxUrl: string;
    repoPath: string;
    issue: string;
  }) => {
    const key = `agent_config:${containerId}:state`;
    await this.redisClient.hset(key, {
      containerId,
      sandboxUrl,
      repoPath,
      issue,
    });
  };

  public getConfig = async (containerId: string) => {
    const key = `agent_config:${containerId}:state`;
    const config = await this.redisClient.hgetall(key);
    return config;
  };

  public addPlanToConfig = async (
    containerId: string,
    plan: { id: string; plan: string; status: Status }[],
  ) => {
    const key = `agent_config:${containerId}:state`;

    if (plan.length === 0) {
      return;
    }
    await this.redisClient.hset(key, "plan", JSON.stringify(plan));
  };

  public getPlanFromConfig = async (containerId: string) => {
    const key = `agent_config:${containerId}:state`;
    const planString = await this.redisClient.hget(key, "plan");
    return planString ? JSON.parse(planString) : [];
  };

  public updatePlanStatus = async (
    containerId: string,
    planId: string,
    newStatus: Status,
  ) => {
    const key = `agent_config:${containerId}:state`;
    const planString = await this.redisClient.hget(key, "plan");
    const plan = planString ? JSON.parse(planString) : [];
    const updatedPlan = plan.map((p: any) => {
      if (p.id === planId) {
        return { ...p, status: newStatus };
      }
      return p;
    });
    await this.redisClient.hset(key, "plan", JSON.stringify(updatedPlan));
  };

  public appendThreadMessage = async (
    containerId: string,
    message: {
      type: "ai" | "user" | "system";
      agentType: AgentType;
      content: string;
      tool_calls?: any[];
    }[],
  ) => {
    if (!message || message.length === 0) {
      return;
    }
    const key = `agent_memory:${containerId}:thread:${message[0]!.agentType || "unknown"}`;

    const stringifiedMessages = message.map((msg) =>
      JSON.stringify({
        type: msg.type,
        content: msg.content,
        tool_calls: msg.tool_calls,
      }),
    );

    await this.redisClient.rpush(key, ...stringifiedMessages);
  };

  public getAllThreadMessages = async (containerId: string) => {
    const key = `agent_memory:${containerId}:thread`;

    const hashKey = `agent_memory:${containerId}:summary`;

    const metaSummary =
      (await this.redisClient.hget(hashKey, "current_summary")) ?? "";

    const totalMessages = await this.redisClient.llen(key);
    if (totalMessages > MAX_BUFFER_THRESHOLD) {
      const compressCount = totalMessages - KEEP_BUFFER_COUNT;

      const rawOldMessages = await this.redisClient.lrange(
        key,
        0,
        compressCount - 1,
      );
      const oldMessages = rawOldMessages.map((msg) => JSON.parse(msg));

      // 🤖 EXECUTE LLM CALL HERE IN YOUR CORE ENGINE:
      // const newSummary = await callLLMToSummarize(metaSummary, oldMessages);
      const newSummary =
        "[System Placeholder] This is your new combined, compressed master summary.";

      // Save the updated, combined master summary back to the metadata hash
      await this.redisClient.hset(hashKey, "current_summary", newSummary);

      // Remove the old messages from the list
      await this.trimThreadMessages(containerId, compressCount);

      const remainingMessages = await this.redisClient.lrange(key, 0, -1);
      const messagesToKeep = remainingMessages.map((msg) => JSON.parse(msg));
      return {
        summary: newSummary,
        messages: messagesToKeep,
      };
    }

    const messages = await this.redisClient.lrange(key, 0, -1);
    const messagesToReturn = messages.map((msg) => JSON.parse(msg));
    return {
      summary: metaSummary,
      messages: messagesToReturn,
    };
  };

  public getCountOfThreadMessages = async (containerId: string) => {
    const key = `agent_memory:${containerId}:thread`;
    const count = await this.redisClient.llen(key);
    return count;
  };

  public trimThreadMessages = async (containerId: string, count: number) => {
    const key = `agent_memory:${containerId}:thread`;
    await this.redisClient.ltrim(key, count, -1);
  };

  public getThreadMessagesByCount = async (
    containerId: string,
    count: number,
  ) => {
    const key = `agent_memory:${containerId}:thread`;
    const messages = await this.redisClient.lrange(key, -count, -1);
    return messages.map((msg) => JSON.parse(msg));
  };

  public getThreadMessagesByRange = async (
    containerId: string,
    start: number,
    end: number,
  ) => {
    const key = `agent_memory:${containerId}:thread`;
    const messages = await this.redisClient.lrange(key, start, end);
    return messages.map((msg) => JSON.parse(msg));
  };

  public clearThreadMessages = async (containerId: string) => {
    const key = `agent_memory:${containerId}:thread`;
    await this.redisClient.del(key);
  };
}
