import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import os from "node:os";
import pty, { type IPty } from "node-pty";
import type { AgentSide } from "../../shared/domain.js";

type AgentProcess = {
  id: string;
  side: AgentSide;
  sessionId?: string;
  pty: IPty;
};

type AgentDataCallback = (payload: { id: string; side: AgentSide; sessionId?: string; data: string }) => void;
type AgentExitCallback = (payload: { id: string; side: AgentSide; sessionId?: string; exitCode: number }) => void;

export class AgentManager {
  private readonly processes = new Map<AgentSide, AgentProcess>();

  constructor(
    private readonly windowProvider: () => BrowserWindow | null,
    private readonly onData?: AgentDataCallback,
    private readonly onExit?: AgentExitCallback
  ) {}

  start(side: AgentSide, command: string, args: string[], cwd: string, sessionId?: string, extraEnv: Record<string, string> = {}): string {
    this.stop(side);
    const id = randomUUID();
    const shell = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd,
      env: { ...process.env, ...extraEnv, PATH: expandedPath(), TERM: "xterm-256color" }
    });

    const proc = { id, side, sessionId, pty: shell };
    this.processes.set(side, proc);

    shell.onData((data) => {
      this.onData?.({ id, side, sessionId, data });
      this.windowProvider()?.webContents.send("agent:data", { side, data, sessionId });
    });
    shell.onExit(({ exitCode }) => {
      this.onExit?.({ id, side, sessionId, exitCode });
      this.windowProvider()?.webContents.send("agent:exit", { side, exitCode, sessionId });
      // Only remove OUR map entry. A slow-dying process's exit must not evict the replacement
      // registered under the same side by a later start() — that would orphan the live pty.
      if (this.processes.get(side)?.id === id) {
        this.processes.delete(side);
      }
    });

    this.windowProvider()?.webContents.send("agent:data", {
      side,
      data: `\r\n[Twindem] started ${command} ${args.join(" ")}\r\n[Twindem] cwd ${cwd}\r\n`,
      sessionId
    });
    return id;
  }

  isRunning(side: AgentSide): boolean {
    return this.processes.has(side);
  }

  runningSession(side: AgentSide): string | undefined {
    return this.processes.get(side)?.sessionId;
  }

  write(side: AgentSide, data: string): void {
    const proc = this.processes.get(side);
    if (!proc) {
      throw new Error(`No running agent process on side ${side}`);
    }
    proc.pty.write(data);
  }

  submit(side: AgentSide, text: string): void {
    const proc = this.processes.get(side);
    if (!proc) {
      throw new Error(`No running agent process on side ${side}`);
    }
    proc.pty.write(normalizePtyText(text));
    setTimeout(() => {
      if (this.processes.get(side)?.id === proc.id) {
        proc.pty.write("\r");
      }
    }, 40);
  }

  resize(side: AgentSide, cols: number, rows: number): void {
    this.processes.get(side)?.pty.resize(cols, rows);
  }

  stop(side: AgentSide): void {
    const proc = this.processes.get(side);
    if (!proc) return;
    proc.pty.kill();
    this.processes.delete(side);
    // A CLI that ignores SIGHUP (or is wedged) would survive as an orphan — escalate after a grace
    // period. Killing an already-dead pid throws; that's the happy path.
    const pid = proc.pty.pid;
    setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }, 2000);
  }

  stopAll(): void {
    for (const side of Array.from(this.processes.keys())) {
      this.stop(side);
    }
  }

  restart(side: AgentSide, command: string, args: string[], cwd: string, sessionId?: string, extraEnv: Record<string, string> = {}): string {
    this.stop(side);
    return this.start(side, command, args, cwd, sessionId, extraEnv);
  }

  defaultShell(): { command: string; args: string[]; cwd: string } {
    return {
      command: process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "zsh"),
      args: os.platform() === "win32" ? [] : ["-l"],
      cwd: process.cwd()
    };
  }
}

function normalizePtyText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function expandedPath(): string {
  const standardPaths = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ];
  return Array.from(new Set([...(process.env.PATH ?? "").split(":").filter(Boolean), ...standardPaths])).join(":");
}
