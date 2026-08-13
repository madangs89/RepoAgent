import { tool } from "@langchain/core/tools";
import * as z from "zod";
import axios from "axios";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAX_OUTPUT_LINES = 200; // hard cap applied to every tool's stdout, regardless of underlying command flags
const MAX_OUTPUT_CHARS = 20000; // secondary cap in case lines are very long (e.g. minified files)

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

const EXCLUDED_DIRS = ["node_modules", ".git", "dist", "build", "vendor", ".next", "coverage"];

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

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function makeTools(container_id: string, sandboxUrl: string) {
  const getFileTree = tool(
    async () => {
      // Array-based cmd, no shell interpolation. Truncation happens in JS (execCmd),
      // not via a shell pipe, so behavior is consistent everywhere.
      return execCmd(sandboxUrl, container_id, ["git", "-C", "repo", "ls-files"]);
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
      assertSafeRelativePath(relPath === "." ? "placeholder" : relPath); // allow "." itself
      const target = relPath === "." ? "repo" : `repo/${relPath}`;
      return execCmd(sandboxUrl, container_id, ["ls", "-la", target]);
    },
    {
      name: "listDirectory",
      description:
        "List the contents of a single directory (non-recursive) in the repository. " +
        "Use this to explore the repo top-down (e.g. list root, then narrow into a subfolder like '.github/workflows') " +
        "instead of reading the entire file tree at once.",
      schema: z.object({
        path: z
          .string()
          .optional()
          .describe("Relative directory path, e.g. '.github/workflows'. Omit or use '.' for repo root."),
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
        lineStart: z.number().int().positive().describe("Starting line number (1-indexed)"),
        lineEnd: z.number().int().positive().describe("Ending line number (inclusive)"),
      }),
    },
  );

  const grepFiles = tool(
    async ({ pattern, path, caseInsensitive, showLineNumbers, filesOnly }) => {
      const target = path ? (assertSafeRelativePath(path), `repo/${path}`) : "repo";

      const flags = ["r", "I"]; // -r recursive, -I skip binary files
      if (caseInsensitive) flags.push("i");
      if (filesOnly) flags.push("l");
      if (showLineNumbers) flags.push("n");

      const excludeArgs = EXCLUDED_DIRS.flatMap((dir) => [`--exclude-dir=${dir}`]);

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
        "node_modules, .git, dist, build, vendor, .next, and coverage directories. Results are truncated to the first 200 lines.",
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
      return execCmd(sandboxUrl, container_id, ["cat", "-n", `repo/${file_name}`]);
    },
    {
      name: "openFile",
      description:
        "Open and read the full contents of a file in the repository, with line numbers " +
        "(output truncated to the first 200 lines — use readFile with a line range for large files instead).",
      schema: z.object({
        file_name: z.string().describe("Full relative path, e.g. src/index.ts"),
      }),
    },
  );

  const writeFile = tool(
    async ({ file_name, content, lineStart, lineEnd }) => {
      assertSafeRelativePath(file_name);

      // Both the file path and the new content are passed through base64 and decoded
      // inside the Python script, rather than being interpolated as raw string literals.
      // This avoids any issue with quotes, backslashes, or special characters in either value.
      const encodedContent = Buffer.from(content, "utf-8").toString("base64");
      const encodedPath = Buffer.from(`repo/${file_name}`, "utf-8").toString("base64");

      const script = `
import base64

path = base64.b64decode("${encodedPath}").decode("utf-8")
with open(path, "r") as f:
    lines = f.readlines()

new_text = base64.b64decode("${encodedContent}").decode("utf-8")
new_lines = new_text.splitlines(keepends=True)
if not new_text.endswith("\\n") and new_lines:
    new_lines[-1] += "\\n"

start = ${lineStart} - 1  # convert to 0-indexed
end = ${lineEnd}          # inclusive end -> exclusive slice bound

lines[start:end] = new_lines

with open(path, "w") as f:
    f.writelines(lines)

print(f"Replaced lines ${lineStart}-${lineEnd} in {path}")
`;
      const encodedScript = Buffer.from(script, "utf-8").toString("base64");

      // bash -c is still needed here to pipe into python3, but the only thing
      // interpolated into the shell string is our own base64 alphabet output —
      // never raw user/file content.
      return execCmd(sandboxUrl, container_id, [
        "bash",
        "-c",
        `echo ${encodedScript} | base64 -d | python3 -`,
      ]);
    },
    {
      name: "writeFile",
      description:
        "Replace a specific line range in a file with new content. To insert without deleting anything, " +
        "set lineStart and lineEnd to the same line number and it will insert before that line. To append, " +
        "use lineStart = lineEnd = totalLines + 1. Always read the file first with readFile/openFile to get " +
        "correct line numbers before writing.",
      schema: z.object({
        file_name: z.string().describe("Full relative path, e.g. src/index.ts"),
        content: z
          .string()
          .describe(
            "The new content to insert, as it should appear in the file (include correct indentation and line breaks).",
          ),
        lineStart: z
          .number()
          .int()
          .positive()
          .describe("First line number to replace (1-indexed, inclusive)."),
        lineEnd: z
          .number()
          .int()
          .positive()
          .describe(
            "Last line number to replace (1-indexed, inclusive). Same as lineStart to insert without replacing.",
          ),
      }),
    },
  );

  return [getFileTree, listDirectory, readFile, grepFiles, openFile, writeFile];
}