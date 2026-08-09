import type { ExecResult } from "shared-types/client";
import Docker from "dockerode";

export interface SandboxBody {
  startSession: (imageName: string) => Promise<Docker.Container>;
  execInSession: (container_id: string, cmd: string[]) => Promise<ExecResult>;
  endSession: (container_id: string) => Promise<void>;
}

export class Sandbox implements SandboxBody {
  private docker: Docker;

  constructor() {
    this.docker = new Docker();
  }

  // Mainly used for checking the existence of an image before attempting to pull it .
  // Actually it checks in local system for the image
  private imageExistsLocally = async (imageName: string): Promise<boolean> => {
    const images = await this.docker.listImages();
    return images.some((img) =>
      (img.RepoTags || []).some(
        (tag) => tag === imageName || tag === `${imageName}:latest`,
      ),
    );
  };

  //   To Pull Images
  private pullImage = async (imageName: string): Promise<void> => {
    console.log(`Pulling image: ${imageName}...`);
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(
        imageName,
        (err: Error | null, stream?: NodeJS.ReadableStream) => {
          if (err || !stream) return reject(err);
          this.docker.modem.followProgress(stream, (err, output) =>
            err ? reject(err) : resolve(),
          );
        },
      );
    });
    console.log(`Pull complete: ${imageName}`);
  };

  // Starting the Session
  public startSession = async (
    imageName: string,
  ): Promise<Docker.Container> => {
    const hasImage = await this.imageExistsLocally(imageName);
    if (!hasImage) await this.pullImage(imageName);
    const container = await this.docker.createContainer({
      Image: imageName,
      Cmd: ["tail", "-f", "/dev/null"], // keeps the container alive indefinitely
      Tty: false,
      HostConfig: { AutoRemove: false },
    });

    await container.start();
    console.log(`Session started. Container ID: ${container.id}`);

    return container;
  };

  // Runs one command inside the already-running container, returns its output
  public execInSession = async (
    container_id: string,
    cmd: string[],
  ): Promise<ExecResult> => {
    const container = this.getContainerById(container_id);

    if (!container) {
      throw new Error(`Container with ID ${container_id} not found`);
    }

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      // demuxStream expects Writable-like objects; NodeJS.WritableStream's
      // write signature is (chunk, encoding, callback) but a minimal object
      // with just `write(chunk)` satisfies dockerode's actual runtime usage.
      // We type these as `NodeJS.WritableStream` via a small cast to keep
      // strict mode happy without pulling in `stream.Writable` machinery.
      const stdoutSink = {
        write: (chunk: Buffer) => {
          stdoutChunks.push(chunk);
          return true;
        },
      } as NodeJS.WritableStream;

      const stderrSink = {
        write: (chunk: Buffer) => {
          stderrChunks.push(chunk);
          return true;
        },
      } as NodeJS.WritableStream;

      this.docker.modem.demuxStream(stream, stdoutSink, stderrSink);

      stream.on("end", () => resolve());
      stream.on("error", (err: Error) => reject(err));
    });

    const inspectData = await exec.inspect();

    return {
      exitCode: inspectData.ExitCode ?? -1,
      stdout: Buffer.concat(stdoutChunks).toString().trim(),
      stderr: Buffer.concat(stderrChunks).toString().trim(),
    };
  };

  // Call this when the agent's task is fully finished
  public endSession = async (container_id: string): Promise<void> => {
    const container = this.getContainerById(container_id);

    if (!container) {
      throw new Error(`Container with ID ${container_id} not found`);
    }
    await container.stop();
    await container.remove();
    console.log(`Session ended and cleaned up: ${container.id}`);
  };

  //   Get the container by its ID
  private getContainerById = (containerId: string): Docker.Container => {
    return this.docker.getContainer(containerId);
  };
}
