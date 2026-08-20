import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
import {
  BaseAgentMemory,
  graph,
} from "agent-core/client";

import { redisClient } from "./utils/Redis";

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

    const finalState = await graph.invoke({
      issue,
      containerId: container_id,
      sandboxUrl,
    });

    return res.status(200).json({
      success: true,
      finalState,
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

app.listen(5000, async () => {
  console.log(process.env.GOOGLE_API_KEY);
  console.log(await redisClient.ping());
  console.log("server is running http://localhost:5000");
});
