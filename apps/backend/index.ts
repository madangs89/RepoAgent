import express from "express";
import axios from "axios";

import { ChatGoogle } from "@langchain/google";
import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { createAgent } from "langchain";
import { HumanMessage } from "@langchain/core/messages";

const model = new ChatGoogle({
  model: "gemini-2.5-flash",
  apiKey: "AIzaSyBZZW4AVRQqXHCDnCaiwQXRiwM4pckPWwk",
});

function makeTools(container_id: string, sandboxUrl: string) {
  const getFileTree = tool(
    async () => {
      const cmd = ["bash", "-c", "cd repo && git ls-files | head -200"];
      const { data } = await axios.post(`${sandboxUrl}/exec-command`, {
        container_id,
        cmd,
      });
      if (!data.success)
        return { exitCode: "", stdout: "", stderr: "Failed to get file tree" };
      return data.result;
    },
    {
      name: "getFileTree",
      description: "Get the list of files in the repository (first 200).",
      schema: z.object({}),
    },
  );

  const readFile = tool(
    async ({ file_name, lineStart, lineEnd }) => {
      const cmd = [
        "bash",
        "-c",
        `cd repo && sed -n '${lineStart},${lineEnd}p' ${file_name}`,
      ];
      const { data } = await axios.post(`${sandboxUrl}/exec-command`, {
        container_id,
        cmd,
      });
      if (!data.success)
        return { exitCode: "", stdout: "", stderr: "Failed to read file" };
      return data.result;
    },
    {
      name: "readFile",
      description: "Read a specific line range from a file in the repository.",
      schema: z.object({
        file_name: z.string().describe("Full relative path, e.g. src/index.ts"),
        lineStart: z.string().describe("Starting line number"),
        lineEnd: z.string().describe("Ending line number"),
      }),
    },
  );

  const grepFiles = tool(
    async ({ pattern, path, caseInsensitive, showLineNumbers, filesOnly }) => {
      const flags = [
        "r",
        caseInsensitive ? "i" : "",
        filesOnly ? "l" : "",
        showLineNumbers ? "n" : "",
      ].join("");
      const cmd = [
        "bash",
        "-c",
        `cd repo && grep -${flags} '${pattern}' ${path ?? "."}`,
      ];
      const { data } = await axios.post(`${sandboxUrl}/exec-command`, {
        container_id,
        cmd,
      });
      if (!data.success)
        return { exitCode: "", stdout: "", stderr: "Failed to search files" };
      return data.result;
    },
    {
      name: "grepFiles",
      description: "Search for a pattern across files in the repository.",
      schema: z.object({
        pattern: z.string().describe("Text or regex to search for"),
        path: z
          .string()
          .optional()
          .describe("Directory/file to search, defaults to repo root"),
        caseInsensitive: z.boolean().optional(),
        showLineNumbers: z.boolean().optional(),
        filesOnly: z.boolean().optional(),
      }),
    },
  );

  return [getFileTree, readFile, grepFiles];
}

function makePlannerAgent(container_id: string) {
  return createAgent({
    model,
    tools: makeTools(container_id, sandboxUrl),
    systemPrompt: `You are a senior software engineer acting as a PLANNER for a coding agent system.

You will be given a GitHub issue describing a bug or feature request, along with access to a cloned repository via tools.

Your job is ONLY to investigate and produce a plan. You must NOT write or modify any code.

Process:
1. Use getFileTree to understand the repo structure.
2. Use grepFiles to locate code relevant to the issue (error messages, function names, keywords from the issue).
3. Use readFile to inspect the relevant sections of the files you find (pass precise line ranges, not entire files, unless the file is small).
4. Reason step by step about the root cause before proposing a fix.

Output format:
Once you have enough context, respond with a plan in this exact structure and nothing else:

## Root Cause
<1-3 sentences>

## Files to Change
- <file path>: <what needs to change and why>

## Steps
1. <concrete, ordered step>
2. ...

Rules:
- Do not guess at file contents — always verify with readFile before referencing specific code.
- If the issue is unclear or you cannot locate relevant code after searching, say so explicitly instead of fabricating a plan.
- Keep the plan concise and actionable — this will be handed to another agent that executes the changes.`,
  });
}

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sandboxUrl = "http://localhost:3000";
app.post("/api/accept", async (req, res) => {
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

    const container_id = sandboxCreationRequest.data.container_id;

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

    const agent = makePlannerAgent(container_id);

    const result = await agent.invoke({
      messages: [new HumanMessage(issue)],
    });

    const finalMessage = result.messages[result.messages.length - 1]!;

    return res.status(200).json({
      success: true,
      plan: finalMessage.content,
      container_id,
    });
  } catch (error) {
    console.error("Error accepting repo:", error);
    res.status(500).json({ message: "Failed to accept repo", success: false });
  }
});

app.listen(5000, () => {
  console.log("server is running http://localhost:5000");
});
