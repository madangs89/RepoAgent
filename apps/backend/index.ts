import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
import { HumanMessage } from "@langchain/core/messages";
import { BaseAgent, BaseAgentMemory, BaseMemoryAgentMemory } from "agent-core/client";
import {
  PlannerResponse,
  PlannerResponseFormat,
  Provider,
  Status,
} from "shared-types/client";
import { redisClient } from "./utils/Redis";



const agent = new BaseAgent({
  apiKey: process.env.GOOGLE_API_KEY!,
  model: "gemini-2.5-flash",
  provider: Provider.GOOGLE,
});

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sandboxUrl = "http://localhost:3000";
app.post("/api/accept", async (req, res) => {
  console.log("Received request to accept repo:", req.body);
  let container_id: string = "";
  try {
    const { repo, issue } = req.body;

    if (!repo.trim()) {
      return res
        .status(400)
        .json({ message: "Repo is required", success: false });
    }

    // Send the request to the sandbox server for creating a sandbox session
    const sandboxCreationRequest = await axios.post(
      `${sandboxUrl}/start-sandbox`,
      {},
    );

    if (!sandboxCreationRequest.data.success) {
      return res.status(500).json({
        message: "Failed to start sandbox",
        success: false,
      });
    }

    container_id = sandboxCreationRequest.data.container_id;

    console.log(`Sandbox created successfully in container ${container_id}`);

    // Execute clone command in the sandbox
    // const cmd = ["bash", "-c", `git clone ${repo} /workspace/repo`];
    const cmd = [
      "bash",
      "-c",
      `GIT_TERMINAL_PROMPT=0 git clone --depth 1 ${repo} /workspace/repo; echo EXIT:$?`,
    ];
    const cloneRepoRequest = await axios.post(`${sandboxUrl}/exec-command`, {
      container_id,
      cmd,
    });
    console.log("Cloned Repo", cloneRepoRequest.data);

    if (!cloneRepoRequest.data.success) {
      return res.status(500).json({
        message: "Failed to clone repo",
        success: false,
      });
    }

    await BaseAgentMemory.addConfig({
      containerId: container_id,
      sandboxUrl: sandboxUrl,
      repoPath: repo,
      issue: issue,
    });

    console.log(`Repo cloned successfully in container ${container_id}`);
    const plannerAgent = agent.getAgent({
      type: "planner",
      context: {
        containerId: container_id,
        sandboxUrl: sandboxUrl,
        repoPath: "/workspace/repo",
        issueId: "123", // You can replace this with
      },
    });

    console.log("Planner Agent created");
    const result = await plannerAgent.invoke({
      messages: [new HumanMessage(issue)],
    });

    console.log("final result from planner agent:", result.structuredResponse);
    const finalMessage = PlannerResponse.safeParse(result.structuredResponse);

    if (!finalMessage.success) {
      console.error("Failed to parse planner response:", finalMessage.error);
      return res.status(500).json({
        message: "Failed to parse planner response",
        success: false,
      });
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

    await BaseAgentMemory.addPlanToConfig(container_id, plan);

    const coderAgent = agent.getAgent({
      type: "coder",
      context: {
        containerId: container_id,
        sandboxUrl: sandboxUrl,
        repoPath: "/workspace/repo",
        issueId: "123", // You can replace this with
      },
    });

    console.log("Coder Agent created");
    const coderResult = await coderAgent.invoke({
      messages: [new HumanMessage(`Plan:\n${finalMessage.data}`)],
    });

    console.log({
      coderResult: coderResult.structuredResponse,
    });

    console.log(
      "Final Message from Coder Agent:",
      coderResult.structuredResponse,
    );

    return res.status(200).json({
      success: true,
      plan: finalMessage.data,
      container_id,
    });
  } catch (error) {
    if (container_id) {
      // add here code to stop the container if it was created
      await axios.post(`${sandboxUrl}/end-sandbox`, { container_id });
    }
    console.error("Error accepting repo:", error);
    res.status(500).json({ message: "Failed to accept repo", success: false });
  }
});

app.listen(5000, () => {
  console.log(process.env.GOOGLE_API_KEY);
  console.log("server is running http://localhost:5000");
});
