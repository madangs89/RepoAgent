import express from "express";
import { Sandbox } from "./skeleton/Sandbox";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sandbox = new Sandbox();
app.post("/start-sandbox", async (req, res) => {
  try {
    const container = await sandbox.startSession("repo-agent-sandbox:latest");

    res.json({
      message: "Sandbox started successfully",
      success: true,
      container_id: container.id,
    });
  } catch (error) {
    console.error("Error starting sandbox:", error);
    res
      .status(500)
      .json({ message: "Failed to start sandbox", success: false });
  }
});

app.post("/exec-command", async (req, res) => {
  const { container_id, cmd } = req.body;

  console.log(
    `Received request to execute command in container ${container_id}:`,
    cmd,
  );

  try {
    const result = await sandbox.execInSession(container_id, cmd);

    console.log({ result });

    if (result.exitCode === 128) {
      res
        .status(500)
        .json({ message: "Repo May be in Private", success: false });
    }

    res.json({ result, success: true });
  } catch (error) {
    console.error("Error executing command:", error);
    res
      .status(500)
      .json({ message: "Failed to execute command", success: false });
  }
});

app.post("/end-sandbox", async (req, res) => {
  const { container_id } = req.body;

  try {
    await sandbox.endSession(container_id);
    res.json({ message: "Sandbox ended successfully", success: true });
  } catch (error) {
    console.error("Error ending sandbox:", error);
    res.status(500).json({ message: "Failed to end sandbox", success: false });
  }
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
