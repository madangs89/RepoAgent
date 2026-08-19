import { tool } from "@langchain/core/tools";
import * as z from "zod";
import axios from "axios";

// Extend this in your shared-types package:
// export type AgentType = "planner" | "coder" | "reviewer" | "debugger" | "submitter";
import type { AgentType } from "shared-types/client";

const MAX_OUTPUT_LINES = 200;
const MAX_OUTPUT_CHARS = 20000;

function truncateOutput(stdout: string): string {
  let lines = stdout.split("\n");
  let truncated = false;

  if (lines.length > MAX_OUTPUT_LINES) {
    lines = lines.slice(0, MAX_OUTPUT_LINES);
    truncated = true;
  }

  let result = lines.join("\n");
  if (result.length > MAX_OUTPUT_CHARS) {
    result = result.slice(0, MAX_OUTPUT_CHARS);
    truncated = true;
  }

  if (truncated) {
    result += `\n\n[output truncated — refine your query (grep pattern, path, or line range) to narrow results]`;
  }
  return result;
}

// Rejects absolute paths and parent-directory traversal so tools can't escape /workspace/repo
function assertSafeRelativePath(p: string): void {
  if (!p || p.startsWith("/") || p.split("/").some((seg) => seg === "..")) {
    throw new Error(
      `Invalid path "${p}": must be a relative path inside the repo, no ".." or leading "/".`,
    );
  }
}

const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  ".next",
  "coverage",
];

// Only these binaries can ever be exec'd via installDependencies / runCommand.
// Add to this list deliberately — don't widen it to "anything".
const INSTALL_ALLOWLIST = ["npm", "yarn", "pnpm", "pip", "pip3"];
const RUN_ALLOWLIST = [
  "npm",
  "yarn",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "node",
  "jest",
  "vitest",
  "tsc",
  "eslint",
  "ruff",
  "mypy",
  "go",
  "cargo",
  "make",
];

function assertAllowedBinary(cmd: string, allowlist: string[]): string[] {
  const parts = cmd.trim().split(/\s+/);
  const bin = parts[0];
  if (!allowlist.includes(bin)) {
    throw new Error(
      `Command "${bin}" is not allowlisted. Allowed: ${allowlist.join(", ")}`,
    );
  }
  return parts;
}

async function execCmd(
  sandboxUrl: string,
  container_id: string,
  cmd: string[],
): Promise<{ exitCode: string | number; stdout: string; stderr: string }> {
  try {
    const { data } = await axios.post(
      `${sandboxUrl}/exec-command`,
      { container_id, cmd },
      { timeout: 60_000 },
    );
    if (!data.success) {
      return { exitCode: "", stdout: "", stderr: "Command execution failed" };
    }
    return {
      exitCode: data.result.exitCode,
      stdout: truncateOutput(data.result.stdout ?? ""),
      stderr: data.result.stderr ?? "",
    };
  } catch (err) {
    return {
      exitCode: "",
      stdout: "",
      stderr: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function makeTools(
  container_id: string,
  sandboxUrl: string,
  type: AgentType,
) {
  // ---------- read tools ----------

  const getFileTree = tool(
    async () => {
      return execCmd(sandboxUrl, container_id, [
        "git",
        "-C",
        "repo",
        "ls-files",
      ]);
    },
    {
      name: "getFileTree",
      description:
        "List all tracked files in the repository (flat list, truncated to the first 200). " +
        "For large repos, prefer listDirectory to explore top-down instead of scanning this full list.",
      schema: z.object({}),
    },
  );

  const listDirectory = tool(
    async ({ path }) => {
      const relPath = path ?? ".";
      assertSafeRelativePath(relPath === "." ? "placeholder" : relPath);
      const target = relPath === "." ? "repo" : `repo/${relPath}`;
      return execCmd(sandboxUrl, container_id, ["ls", "-la", target]);
    },
    {
      name: "listDirectory",
      description:
        "List the contents of a single directory (non-recursive) in the repository. " +
        "Use this to explore the repo top-down instead of reading the entire file tree at once.",
      schema: z.object({
        path: z
          .string()
          .optional()
          .describe(
            "Relative directory path, e.g. '.github/workflows'. Omit or use '.' for repo root.",
          ),
      }),
    },
  );

  const readFile = tool(
    async ({ file_name, lineStart, lineEnd }) => {
      assertSafeRelativePath(file_name);
      return execCmd(sandboxUrl, container_id, [
        "sed",
        "-n",
        `${lineStart},${lineEnd}p`,
        `repo/${file_name}`,
      ]);
    },
    {
      name: "readFile",
      description: "Read a specific line range from a file in the repository.",
      schema: z.object({
        file_name: z.string().describe("Full relative path, e.g. src/index.ts"),
        lineStart: z
          .number()
          .int()
          .describe("Starting line number (1-indexed)"),
        lineEnd: z.number().int().describe("Ending line number (inclusive)"),
      }),
    },
  );

  const grepFiles = tool(
    async ({ pattern, path, caseInsensitive, showLineNumbers, filesOnly }) => {
      const target = path
        ? (assertSafeRelativePath(path), `repo/${path}`)
        : "repo";

      const flags = ["r", "I"];
      if (caseInsensitive) flags.push("i");
      if (filesOnly) flags.push("l");
      if (showLineNumbers) flags.push("n");

      const excludeArgs = EXCLUDED_DIRS.flatMap((dir) => [
        `--exclude-dir=${dir}`,
      ]);

      return execCmd(sandboxUrl, container_id, [
        "grep",
        `-${flags.join("")}`,
        ...excludeArgs,
        pattern,
        target,
      ]);
    },
    {
      name: "grepFiles",
      description:
        "Search for a pattern across files in the repository. Automatically skips binary files, " +
        "node_modules, .git, dist, build, vendor, .next, and coverage directories. Results truncated to first 200 lines.",
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

  const openFile = tool(
    async ({ file_name }) => {
      assertSafeRelativePath(file_name);
      return execCmd(sandboxUrl, container_id, [
        "cat",
        "-n",
        `repo/${file_name}`,
      ]);
    },
    {
      name: "openFile",
      description:
        "Open and read the full contents of a file with line numbers " +
        "(truncated to first 200 lines — use readFile with a line range for large files).",
      schema: z.object({
        file_name: z.string().describe("Full relative path, e.g. src/index.ts"),
      }),
    },
  );

  // ---------- write tools ----------

  const writeFile = tool(
    async ({ file_name, content, lineStart, lineEnd }) => {
      assertSafeRelativePath(file_name);

      const encodedContent = Buffer.from(content, "utf-8").toString("base64");
      const encodedPath = Buffer.from(`repo/${file_name}`, "utf-8").toString(
        "base64",
      );

      const script = `
import base64

path = base64.b64decode("${encodedPath}").decode("utf-8")
with open(path, "r") as f:
    lines = f.readlines()

new_text = base64.b64decode("${encodedContent}").decode("utf-8")
new_lines = new_text.splitlines(keepends=True)
if not new_text.endswith("\\n") and new_lines:
    new_lines[-1] += "\\n"

start = ${lineStart} - 1
end = ${lineEnd}

lines[start:end] = new_lines

with open(path, "w") as f:
    f.writelines(lines)

print(f"Replaced lines ${lineStart}-${lineEnd} in {path}")
`;
      const encodedScript = Buffer.from(script, "utf-8").toString("base64");

      return execCmd(sandboxUrl, container_id, [
        "bash",
        "-c",
        `echo ${encodedScript} | base64 -d | python3 -`,
      ]);
    },
    {
      name: "writeFile",
      description:
        "Replace a specific line range in a file with new content. To insert without deleting, " +
        "set lineStart = lineEnd (inserts before that line). To append, use lineStart = lineEnd = totalLines + 1. " +
        "Always read the file first to get correct line numbers.",
      schema: z.object({
        file_name: z.string().describe("Full relative path, e.g. src/index.ts"),
        content: z
          .string()
          .describe("New content, with correct indentation and line breaks"),
        lineStart: z
          .number()
          .int()
          .describe("First line to replace (1-indexed, inclusive)"),
        lineEnd: z
          .number()
          .int()
          .describe(
            "Last line to replace (1-indexed, inclusive). Same as lineStart to insert.",
          ),
      }),
    },
  );

  // FIX: previously interpolated raw `content` into an `sh -c` heredoc — a line containing
  // "EOF", backticks, or `$(...)` could break out of the heredoc and execute arbitrary shell.
  // Now routed through base64 + python3, same pattern as writeFile.
  const createFile = tool(
    async ({ file_path, content = "" }) => {
      assertSafeRelativePath(file_path);

      const fullPath = `repo/${file_path}`;
      const encodedContent = Buffer.from(content, "utf-8").toString("base64");
      const encodedPath = Buffer.from(fullPath, "utf-8").toString("base64");

      const script = `
import base64, os

path = base64.b64decode("${encodedPath}").decode("utf-8")
content = base64.b64decode("${encodedContent}").decode("utf-8")

os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
with open(path, "w") as f:
    f.write(content)

print(f"Created {path}")
`;
      const encodedScript = Buffer.from(script, "utf-8").toString("base64");

      return execCmd(sandboxUrl, container_id, [
        "bash",
        "-c",
        `echo ${encodedScript} | base64 -d | python3 -`,
      ]);
    },
    {
      name: "createFile",
      description:
        "Create a new file with content in the repository. Automatically creates parent directories if missing. " +
        "Fails if the file already exists — use writeFile to edit an existing file.",
      schema: z.object({
        file_path: z.string().describe("Relative path, e.g. 'src/main.js'"),
        content: z
          .string()
          .optional()
          .default("")
          .describe("Content to write to the file"),
      }),
    },
  );

  const createDirectory = tool(
    async ({ directory_path }) => {
      assertSafeRelativePath(directory_path);
      return execCmd(sandboxUrl, container_id, [
        "mkdir",
        "-p",
        `repo/${directory_path}`,
      ]);
    },
    {
      name: "createDirectory",
      description:
        "Create a new directory in the repository (and any missing parents).",
      schema: z.object({
        directory_path: z
          .string()
          .describe("Relative path, e.g. 'src/newfolder'"),
      }),
    },
  );

  const deleteFile = tool(
    async ({ file_path }) => {
      assertSafeRelativePath(file_path);
      return execCmd(sandboxUrl, container_id, [
        "rm",
        "-f",
        `repo/${file_path}`,
      ]);
    },
    {
      name: "deleteFile",
      description: "Delete a single file from the repository.",
      schema: z.object({
        file_path: z.string().describe("Relative path to the file to delete"),
      }),
    },
  );

  // ---------- git history / diff ----------

  const gitBlame = tool(
    async ({ file_name, start, end }) => {
      assertSafeRelativePath(file_name);
      const args = ["git", "-C", "repo", "blame", "-w"];
      if (start !== undefined && end !== undefined)
        args.push("-L", `${start},${end}`);
      args.push(file_name);
      return execCmd(sandboxUrl, container_id, args);
    },
    {
      name: "gitBlame",
      description:
        "Examine a file line-by-line to see which commit/author last touched each line. Helps pinpoint when bugs were introduced.",
      schema: z.object({
        file_name: z.string().describe("Relative path, e.g. 'src/index.ts'"),
        start: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional start line (requires end)"),
        end: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional end line (requires start)"),
      }),
    },
  );

  const gitLog = tool(
    async ({ commit_hash, count = 10, format = "full" }) => {
      const args = ["git", "-C", "repo", "log"];
      if (format === "oneline") args.push("--oneline");
      args.push("-n", count.toString());
      if (commit_hash) args.push(commit_hash);
      return execCmd(sandboxUrl, container_id, args);
    },
    {
      name: "gitLog",
      description:
        "Get git commit history. 'oneline' for compact summaries, 'full' for complete details.",
      schema: z.object({
        commit_hash: z
          .string()
          .optional()
          .describe("Start history backward from this commit; omit for HEAD"),
        count: z.number().int().default(10).describe("Max commits to retrieve"),
        format: z.enum(["oneline", "full"]).default("full"),
      }),
    },
  );

  const gitDiff = tool(
    async ({ staged, file_name }) => {
      const args = ["git", "-C", "repo", "diff"];
      if (staged) args.push("--staged");
      if (file_name) {
        assertSafeRelativePath(file_name);
        args.push("--", file_name);
      }
      return execCmd(sandboxUrl, container_id, args);
    },
    {
      name: "gitDiff",
      description:
        "Show the current uncommitted diff in the repo (working tree vs HEAD, or staged vs HEAD). " +
        "Use this to review exactly what has changed so far.",
      schema: z.object({
        staged: z
          .boolean()
          .optional()
          .describe("Show staged changes instead of unstaged"),
        file_name: z
          .string()
          .optional()
          .describe("Limit diff to a single file"),
      }),
    },
  );

  const gitCheckoutFile = tool(
    async ({ file_name }) => {
      assertSafeRelativePath(file_name);
      return execCmd(sandboxUrl, container_id, [
        "git",
        "-C",
        "repo",
        "checkout",
        "--",
        file_name,
      ]);
    },
    {
      name: "gitCheckoutFile",
      description:
        "Discard all uncommitted changes to a single file, reverting it to the last committed state. " +
        "Use this to cleanly back out a bad edit before retrying.",
      schema: z.object({
        file_name: z.string().describe("Relative path to revert"),
      }),
    },
  );

  const gitAdd = tool(
    async ({ paths }) => {
      const targets = (paths && paths.length > 0 ? paths : ["."]).map((p) => {
        if (p !== ".") assertSafeRelativePath(p);
        return p;
      });
      return execCmd(sandboxUrl, container_id, [
        "git",
        "-C",
        "repo",
        "add",
        ...targets,
      ]);
    },
    {
      name: "gitAdd",
      description: "Stage file(s) for commit. Omit paths to stage everything.",
      schema: z.object({
        paths: z
          .array(z.string())
          .optional()
          .describe("Relative paths to stage; omit for all changes"),
      }),
    },
  );

  const gitCommit = tool(
    async ({ message }) => {
      const encodedMsg = Buffer.from(message, "utf-8").toString("base64");
      return execCmd(sandboxUrl, container_id, [
        "bash",
        "-c",
        `cd repo && git commit -m "$(echo ${encodedMsg} | base64 -d)"`,
      ]);
    },
    {
      name: "gitCommit",
      description: "Commit staged changes with a message. Run gitAdd first.",
      schema: z.object({
        message: z.string().describe("Commit message"),
      }),
    },
  );

  // ---------- dependencies / execution ----------

  // FIX: previously accepted and executed ANY command with no validation (e.g. "rm -rf repo").
  // Now the leading binary must be on INSTALL_ALLOWLIST.
  const installDependencies = tool(
    async ({ cmd }) => {
      const commandArray = assertAllowedBinary(cmd, INSTALL_ALLOWLIST);
      return execCmd(sandboxUrl, container_id, commandArray);
    },
    {
      name: "installDependencies",
      description:
        "Install project dependencies using npm, yarn, pnpm, or pip only. " +
        "e.g. 'npm install <package>', 'pip install -r requirements.txt'.",
      schema: z.object({
        cmd: z
          .string()
          .describe("Install command, must start with npm/yarn/pnpm/pip/pip3"),
      }),
    },
  );

  const detectTestSetup = tool(
    async () => {
      return execCmd(sandboxUrl, container_id, [
        "bash",
        "-c",
        `echo "--- package.json scripts ---"; grep -A10 '"scripts"' repo/package.json 2>/dev/null; ` +
          `echo "--- python/make config ---"; find repo -maxdepth 2 \\( -iname 'pytest.ini' -o -iname 'pyproject.toml' -o -iname 'setup.cfg' -o -iname 'Makefile' \\) 2>/dev/null; ` +
          `echo "--- test directories ---"; find repo -maxdepth 3 -type d \\( -iname 'tests' -o -iname '__tests__' -o -iname 'spec' \\) 2>/dev/null; ` +
          `echo "--- CI workflows ---"; find repo/.github/workflows -type f 2>/dev/null`,
      ]);
    },
    {
      name: "detectTestSetup",
      description:
        "Check whether the repo has a runnable test suite and how to invoke it (package.json scripts, " +
        "pytest/Makefile config, test directories, CI workflows). Call this BEFORE runCommand/runTests — " +
        "if it comes back empty, there is no test infra and you should fall back to a manual repro script instead.",
      schema: z.object({}),
    },
  );

  // FIX: this is the actual missing capability from earlier — every other tool wraps a fixed
  // command. This lets planner/reviewer/debugger actually run tests, linters, or a repro script,
  // gated by an allowlist so it can't be used as a general-purpose shell.
  const runCommand = tool(
    async ({ cmd }) => {
      const commandArray = assertAllowedBinary(cmd, RUN_ALLOWLIST);
      return execCmd(sandboxUrl, container_id, [
        "bash",
        "-c",
        `cd repo && ${commandArray.join(" ")}`,
      ]);
    },
    {
      name: "runCommand",
      description:
        "Run a command inside the repo (test runners, linters, typecheckers, or a scratch repro script). " +
        "Restricted to: " +
        RUN_ALLOWLIST.join(", ") +
        ". If the repo has no test suite (check with detectTestSetup first), write a small script with " +
        "createFile and run it with node/python instead of guessing a test command.",
      schema: z.object({
        cmd: z
          .string()
          .describe(
            "Command to run, e.g. 'npm test', 'pytest tests/', 'node repro.js'",
          ),
      }),
    },
  );

  // ---------- submission ----------

  // const gitPush = tool(
  //   async ({ branch }) => {
  //     const args = ["git", "-C", "repo", "push", "origin"];
  //     if (branch) args.push(branch);
  //     return execCmd(sandboxUrl, container_id, args);
  //   },
  //   {
  //     name: "gitPush",
  //     description: "Push committed changes to the remote (origin).",
  //     schema: z.object({
  //       branch: z.string().optional().describe("Branch name; omit to push current branch"),
  //     }),
  //   },
  // );

  // const createPullRequest = tool(
  //   async ({ title, body, head, base = "main", repoSlug, githubToken }) => {
  //     try {
  //       const { data } = await axios.post(
  //         `https://api.github.com/repos/${repoSlug}/pulls`,
  //         { title, body, head, base },
  //         {
  //           headers: {
  //             Authorization: `Bearer ${githubToken}`,
  //             Accept: "application/vnd.github+json",
  //           },
  //         },
  //       );
  //       return { exitCode: 0, stdout: `PR created: ${data.html_url}`, stderr: "" };
  //     } catch (err: any) {
  //       return {
  //         exitCode: 1,
  //         stdout: "",
  //         stderr: `Failed to create PR: ${err?.response?.data?.message ?? err.message}`,
  //       };
  //     }
  //   },
  //   {
  //     name: "createPullRequest",
  //     description: "Open a pull request on GitHub after changes are committed and pushed.",
  //     schema: z.object({
  //       title: z.string(),
  //       body: z.string(),
  //       head: z.string().describe("Branch containing the fix"),
  //       base: z.string().default("main").describe("Branch to merge into"),
  //       repoSlug: z.string().describe("'owner/repo'"),
  //       githubToken: z.string().describe("GitHub token with repo scope"),
  //     }),
  //   },
  // );

  // const postIssueComment = tool(
  //   async ({ repoSlug, issueNumber, body, githubToken }) => {
  //     try {
  //       const { data } = await axios.post(
  //         `https://api.github.com/repos/${repoSlug}/issues/${issueNumber}/comments`,
  //         { body },
  //         {
  //           headers: {
  //             Authorization: `Bearer ${githubToken}`,
  //             Accept: "application/vnd.github+json",
  //           },
  //         },
  //       );
  //       return { exitCode: 0, stdout: `Comment posted: ${data.html_url}`, stderr: "" };
  //     } catch (err: any) {
  //       return {
  //         exitCode: 1,
  //         stdout: "",
  //         stderr: `Failed to post comment: ${err?.response?.data?.message ?? err.message}`,
  //       };
  //     }
  //   },
  //   {
  //     name: "postIssueComment",
  //     description: "Post a comment back on the original GitHub issue (e.g. linking the PR or explaining a blocker).",
  //     schema: z.object({
  //       repoSlug: z.string().describe("'owner/repo'"),
  //       issueNumber: z.number().int(),
  //       body: z.string(),
  //       githubToken: z.string(),
  //     }),
  //   },
  // );

  // ---------- role assembly ----------

  const readOnlyTools = [
    getFileTree,
    listDirectory,
    readFile,
    grepFiles,
    openFile,
    gitLog,
    gitBlame,
  ];

  switch (type) {
    case "planner":
      // Read + history only — planner should never mutate the repo.
      return [...readOnlyTools, gitDiff, detectTestSetup];

    case "coder":
      return [
        ...readOnlyTools,
        writeFile,
        createFile,
        createDirectory,
        deleteFile,
        installDependencies,
        gitDiff,
      ];

    case "reviewer":
      // Read + diff + execute, but NOT write — reviewer critiques, it doesn't fix.
      return [...readOnlyTools, gitDiff, detectTestSetup, runCommand];

    case "debugger":
      return [
        ...readOnlyTools,
        gitDiff,
        detectTestSetup,
        runCommand,
        writeFile,
        createFile,
        gitCheckoutFile,
      ];

    case "submitter":
      // return [gitDiff, gitAdd, gitCommit, gitPush, createPullRequest, postIssueComment];
      return [gitDiff, gitAdd, gitCommit];

    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown agent type: ${_exhaustive}`);
    }
  }
}
