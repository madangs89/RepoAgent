import { tool } from "@langchain/core/tools";
import * as z from "zod";
import axios from "axios";

const sandboxUrl = "http://localhost:3000";

export function makeTools(container_id: string, sandboxUrl: string) {
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
  const openFile = tool(
    async ({ file_name }) => {
      const cmd = ["bash", "-c", `cd repo && cat -n ${file_name}`];
      const { data } = await axios.post(`${sandboxUrl}/exec-command`, {
        container_id,
        cmd,
      });
      if (!data.success)
        return { exitCode: "", stdout: "", stderr: "Failed to open file" };
      return data.result;
    },
    {
      name: "openFile",
      description:
        "Open and read the full contents of a file in the repository, with line numbers. Use readFile instead if you only need a specific line range from a large file.",
      schema: z.object({
        file_name: z.string().describe("Full relative path, e.g. src/index.ts"),
      }),
    },
  );
  const writeFile = tool(
    async ({ file_name, content, lineStart, lineEnd }) => {
      // Encode content so newlines/quotes/special chars never touch the shell directly
      const encodedContent = Buffer.from(content, "utf-8").toString("base64");

      const script = `
import base64
path = "${file_name}"
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

      const cmd = [
        "bash",
        "-c",
        `cd repo && echo ${encodedScript} | base64 -d | python3 -`,
      ];

      const { data } = await axios.post(`${sandboxUrl}/exec-command`, {
        container_id,
        cmd,
      });

      if (!data.success)
        return { exitCode: "", stdout: "", stderr: "Failed to write file" };
      return data.result;
    },
    {
      name: "writeFile",
      description:
        "Replace a specific line range in a file with new content. To insert without deleting anything, set lineStart and lineEnd to the same line number and it will insert before that line. To append, use lineStart = lineEnd = totalLines + 1. Always read the file first with readFile/openFile to get correct line numbers before writing.",
      schema: z.object({
        file_name: z.string().describe("Full relative path, e.g. src/index.ts"),
        content: z
          .string()
          .describe(
            "The new content to insert, as it should appear in the file (include correct indentation and line breaks).",
          ),
        lineStart: z
          .number()
          .describe("First line number to replace (1-indexed, inclusive)."),
        lineEnd: z
          .number()
          .describe(
            "Last line number to replace (1-indexed, inclusive). Same as lineStart to insert without replacing.",
          ),
      }),
    },
  );

  return [getFileTree, readFile, grepFiles, openFile, writeFile];
}
