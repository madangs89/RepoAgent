import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

import { HumanMessage } from "@langchain/core/messages";
import { BaseAgent } from "agent-core/client";
import { Provider } from "shared-types/client";

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

    // Execute clone command in the sandbox
    const cmd = ["bash", "-c", `git clone ${repo} /workspace/repo`];

    const cloneRepoRequest = await axios.post(`${sandboxUrl}/exec-command`, {
      container_id,
      cmd,
    });

    if (!cloneRepoRequest.data.success) {
      return res.status(500).json({
        message: "Failed to clone repo",
        success: false,
      });
    }

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

    const finalMessage = result.messages[result.messages.length - 1]!;

    console.log("Final Message from Planner Agent:", finalMessage.content);

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
      messages: [new HumanMessage(`Plan:\n${finalMessage.content}`)],
    });

    console.log(
      "Final Message from Coder Agent:",
      coderResult.messages[coderResult.messages.length - 1]!.content,
    );

    return res.status(200).json({
      success: true,
      plan: finalMessage.content,
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
