import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type SaveDialogOptions
} from "electron";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { TandemDatabase } from "./database.js";
import {
  loadTandemConfig,
  readTandemConfigFile,
  saveUserTandemConfig,
  writeTandemConfigFile
} from "./config-store.js";
import { AgentManager } from "./agent-manager.js";
import { GitHubBoardProvider, type BoardProvider } from "./board-provider.js";
import { GitHubService } from "./github-service.js";
import { JiraService } from "./jira-service.js";
import type { TandemConfig } from "../../shared/config.js";
import type { BoardStatusSlot } from "../../shared/config.js";
import { boardProviderForWorkspace, isDeployableWorkspace } from "../../shared/config.js";
import {
  boardStatusCandidatesForSlot,
  boardStatusForSlot,
  sessionStateForSlot,
  slotForBoardStatus
} from "../../shared/status-mapping.js";
import type {
  AgentSide,
  AgentSignal,
  AgentSignalVerdict,
  BoardProviderKey,
  ComposerMessageInput,
  CreateSessionInput,
  EvidenceRecordInput,
  EvidenceStatus,
  GitHubIssueContext,
  ProposedTask,
  ReviewFinding,
  SessionDetail,
  TaskReviewVerdict,
  UpdateSessionInput,
  WorkflowTransitionTarget,
  WorkflowActionResult,
  BoardArtifactOption
} from "../../shared/domain.js";
import { IDEA_TYPES, ideaTypeDefinition, inferIdeaType, labelsForIdeaType } from "../../shared/idea-types.js";
import { estimateTokens } from "../../shared/text.js";
import type { CommandCheckResult, TandemResult } from "../../shared/api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const execFileAsync = promisify(execFile);

let mainWindow: BrowserWindow | null = null;
let db: TandemDatabase;
let agents: AgentManager;
let github: GitHubService;
let board: BoardProvider;

const PTY_FLUSH_MS = 2000;
const PTY_FLUSH_BYTES = 8192;

type PtyBuffer = {
  sessionId: string;
  side: AgentSide;
  chunks: string[];
  bytes: number;
  timer?: NodeJS.Timeout;
};

const ptyBuffers = new Map<string, PtyBuffer>();

function ptyBufferKey(sessionId: string, side: AgentSide): string {
  return `${sessionId}:${side}`;
}

function bufferPtyTranscript(sessionId: string, side: AgentSide, data: string): void {
  const key = ptyBufferKey(sessionId, side);
  const existing = ptyBuffers.get(key);
  const buffer =
    existing ??
    {
      sessionId,
      side,
      chunks: [],
      bytes: 0
    };

  buffer.chunks.push(data);
  buffer.bytes += Buffer.byteLength(data, "utf8");

  if (!buffer.timer) {
    buffer.timer = setTimeout(() => flushPtyTranscript(key), PTY_FLUSH_MS);
  }

  ptyBuffers.set(key, buffer);

  if (buffer.bytes >= PTY_FLUSH_BYTES) {
    flushPtyTranscript(key);
  }
}

function setAttentionBadge(active: boolean): void {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setBadge(active ? "1" : "");
  }
  if (typeof app.setBadgeCount === "function") {
    app.setBadgeCount(active ? 1 : 0);
  }
}

function flushPtyTranscript(key: string): void {
  const buffer = ptyBuffers.get(key);
  if (!buffer) return;
  if (buffer.timer) clearTimeout(buffer.timer);
  ptyBuffers.delete(key);
  const content = buffer.chunks.join("");
  db.addPtyTranscript(buffer.sessionId, buffer.side, content);
  addUsageEstimate(buffer.sessionId, buffer.side, "output", content, "app");
}

function flushAllPtyTranscripts(): void {
  for (const key of Array.from(ptyBuffers.keys())) {
    flushPtyTranscript(key);
  }
}

// TUI usage estimation: one usage_events row per agent run, accumulated in memory next to the
// pty buffers and written with a throttled upsert (finalized at run exit / app quit). A row per
// PTY flush would bloat the table — a long run produces thousands of flushes.
const USAGE_FLUSH_MS = 20000;

type UsageAccumulator = {
  runId: string;
  sessionId: string;
  side: AgentSide;
  phase?: string;
  provider?: string;
  model?: string;
  inputEstimateTokens: number;
  outputEstimateTokens: number;
  startedAt: string;
  dirty: boolean;
};

const usageAccumulators = new Map<string, UsageAccumulator>();
const activeRunBySide = new Map<string, string>();
let usageFlushTimer: NodeJS.Timeout | null = null;

function registerUsageRun(runId: string, sessionId: string, side: AgentSide, provider?: string): void {
  const detail = db.getSession(sessionId);
  const model = provider ? loadTandemConfig().providers[provider]?.model : undefined;
  usageAccumulators.set(runId, {
    runId,
    sessionId,
    side,
    phase: detail?.session.visiblePhase,
    provider,
    model,
    inputEstimateTokens: 0,
    outputEstimateTokens: 0,
    startedAt: new Date().toISOString(),
    dirty: true
  });
  activeRunBySide.set(`${sessionId}:${side}`, runId);
  if (!usageFlushTimer) {
    usageFlushTimer = setInterval(() => flushUsageAccumulators(), USAGE_FLUSH_MS);
  }
}

// Counted ONCE per message: composer input hooks here from the single composer:send IPC point
// (which both inserts the transcript and writes PTY input); PTY output hooks from the transcript
// flush. Volume is estimated after ANSI stripping.
function addUsageEstimate(
  sessionId: string,
  side: AgentSide,
  kind: "input" | "output",
  text: string,
  source: "composer" | "app"
): void {
  const tokens = estimateTokens(text);
  if (tokens <= 0) return;
  const runId = activeRunBySide.get(`${sessionId}:${side}`);
  const accumulator = runId ? usageAccumulators.get(runId) : undefined;
  if (accumulator) {
    if (kind === "input") accumulator.inputEstimateTokens += tokens;
    else accumulator.outputEstimateTokens += tokens;
    accumulator.dirty = true;
    return;
  }
  db.addStandaloneUsageEvent({
    sessionId,
    side,
    inputEstimateTokens: kind === "input" ? tokens : 0,
    outputEstimateTokens: kind === "output" ? tokens : 0,
    source
  });
}

function flushUsageAccumulators(): void {
  for (const accumulator of usageAccumulators.values()) {
    if (!accumulator.dirty) continue;
    accumulator.dirty = false;
    db.upsertRunUsage(accumulator);
  }
}

function finalizeUsageRun(runId: string): void {
  const accumulator = usageAccumulators.get(runId);
  if (!accumulator) return;
  usageAccumulators.delete(runId);
  const sideKey = `${accumulator.sessionId}:${accumulator.side}`;
  if (activeRunBySide.get(sideKey) === runId) activeRunBySide.delete(sideKey);
  db.upsertRunUsage({ ...accumulator, endedAt: new Date().toISOString() });
}

function finalizeAllUsageRuns(): void {
  for (const runId of Array.from(usageAccumulators.keys())) {
    finalizeUsageRun(runId);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1100,
    minHeight: 760,
    title: "Twindem",
    icon: join(__dirname, "../../../build/icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // The renderer displays untrusted remote content (GitHub issue bodies/comments). Any navigation
  // or window.open it triggers must NOT become a BrowserWindow that inherits the preload (which
  // exposes agents.start = command execution). External links open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    const allowed = (devUrl && url.startsWith(devUrl)) || url.startsWith("file://");
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../../../dist/index.html"));
  }

  mainWindow.on("focus", () => {
    setAttentionBadge(false);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function sendRendererAppEvent(channel: "app:newProject" | "app:openSettings" | "app:about"): void {
  if (!mainWindow) createWindow();
  mainWindow?.show();
  mainWindow?.focus();
  mainWindow?.webContents.send(channel);
}

function createApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "Twindem",
            submenu: [
              { label: "About Twindem", click: () => sendRendererAppEvent("app:about") },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const }
            ]
          }
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Project...",
          accelerator: "CmdOrCtrl+N",
          click: () => sendRendererAppEvent("app:newProject")
        },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => sendRendererAppEvent("app:openSettings")
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : [])]
    },
    {
      role: "help",
      submenu: [
        { label: "About Twindem", click: () => sendRendererAppEvent("app:about") },
        { label: "Licenses", click: () => sendRendererAppEvent("app:about") }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Delete everything LOCAL for a project (workspace): its sessions + all their DB rows, the .twindem
// scratch/cache inside the project folder, the saved Jira token, and the workspace config entry. Never
// touches the user's code folder itself, and never touches the remote board (GitHub/Jira issues stay).
async function deleteWorkspaceProject(workspaceName: string): Promise<{ deletedSessions: number; project: string }> {
  const config = loadTandemConfig();
  const workspace = config.workspaces.find((candidate) => candidate.name === workspaceName);
  if (!workspace) throw new Error("Project not found.");
  if (config.workspaces.length <= 1) {
    throw new Error("This is the only project — create another first, then delete this one.");
  }
  // 1. Sessions (+ all cascading rows) for this workspace.
  const activeId = db.getActiveSessionId();
  const activeDetail = activeId ? db.getSession(activeId) : null;
  const deletedSessions = db.deleteSessionsForWorkspace(workspaceName, config.defaults.workspaceName);
  if (activeDetail && (activeDetail.session.workspaceName ?? config.defaults.workspaceName) === workspaceName) {
    db.setActiveSessionId(null);
  }
  // 2. Twindem's local scratch/cache INSIDE the project folder (.twindem only — never the code itself).
  const root = workspace.root?.trim();
  if (root) {
    try {
      const scratch = join(root, ".twindem");
      if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  // 3. Saved Jira token for this workspace.
  if (workspace.jiraApiTokenSecretRef) {
    try {
      clearAgentApiKeySecret(workspace.jiraApiTokenSecretRef);
    } catch {
      /* best-effort */
    }
  }
  // 4. Remove the workspace from config; repoint the active-project default if needed.
  const nextWorkspaces = config.workspaces.filter((candidate) => candidate.name !== workspaceName);
  const nextDefault =
    config.defaults.workspaceName === workspaceName ? nextWorkspaces[0]?.name : config.defaults.workspaceName;
  saveUserTandemConfig({
    ...config,
    workspaces: nextWorkspaces,
    defaults: { ...config.defaults, workspaceName: nextDefault }
  });
  return { deletedSessions, project: workspaceName };
}

async function safe<T>(operation: () => T | Promise<T>): Promise<TandemResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { message } };
  }
}

function registerIpc(): void {
  ipcMain.handle("app:version", () => safe(() => app.getVersion()));
  ipcMain.handle("app:setAttentionBadge", (_event, active: boolean) =>
    safe(() => {
      setAttentionBadge(Boolean(active));
    })
  );
  ipcMain.handle("project:delete", (_event, workspaceName: string) => safe(() => deleteWorkspaceProject(workspaceName)));
  ipcMain.handle("config:get", () => safe(() => loadTandemConfig()));
  ipcMain.handle("config:save", (_event, config: TandemConfig) =>
    safe(() => {
      invalidateSignalsDirCache();
      return saveUserTandemConfig(config);
    })
  );
  ipcMain.handle("config:pickDirectory", () => safe(() => pickDirectory()));
  ipcMain.handle("config:pickFiles", (_event, defaultPath?: string) => safe(() => pickFiles(defaultPath)));
  ipcMain.handle("config:importFile", () =>
    safe(() => {
      invalidateSignalsDirCache();
      return importConfigFile();
    })
  );
  ipcMain.handle("config:exportFile", (_event, config: TandemConfig) => safe(() => exportConfigFile(config)));
  ipcMain.handle("secrets:set", (_event, ref: string, value: string) =>
    safe(() => setAgentApiKeySecret(ref, value))
  );
  ipcMain.handle("secrets:has", (_event, ref: string) => safe(() => hasAgentApiKeySecret(ref)));
  ipcMain.handle("secrets:clear", (_event, ref: string) => safe(() => clearAgentApiKeySecret(ref)));
  ipcMain.handle("secrets:setAgentApiKey", (_event, ref: string, value: string) =>
    safe(() => setAgentApiKeySecret(ref, value))
  );
  ipcMain.handle("secrets:hasAgentApiKey", (_event, ref: string) => safe(() => hasAgentApiKeySecret(ref)));
  ipcMain.handle("secrets:clearAgentApiKey", (_event, ref: string) => safe(() => clearAgentApiKeySecret(ref)));
  ipcMain.handle("secrets:validateAgentApiKey", (_event, envName: string, value: string) =>
    safe(() => validateAgentApiKey(envName, value))
  );
  ipcMain.handle("sessions:list", () => safe(() => db.listSessions()));
  ipcMain.handle("sessions:get", (_event, id: string) => safe(() => db.getSession(id)));
  ipcMain.handle("sessions:create", (_event, input: CreateSessionInput) => safe(() => createSession(input)));
  ipcMain.handle("sessions:update", (_event, input: UpdateSessionInput) =>
    safe(() => {
      invalidateSignalsDirCache();
      return db.updateSession(input);
    })
  );
  ipcMain.handle("sessions:syncNotStartedBoard", (_event, id: string) => safe(() => syncNotStartedBoard(id)));
  ipcMain.handle("sessions:delete", (_event, id: string, options?: { deleteBoardArtifact?: boolean }) =>
    safe(() => deleteSession(id, options))
  );
  ipcMain.handle("sessions:download", (_event, id: string) => safe(() => downloadSession(id)));
  ipcMain.handle("sessions:setHidden", (_event, id: string, hidden: boolean) =>
    safe(() => db.setSessionHidden(id, hidden))
  );
  ipcMain.handle("sessions:getActive", () => safe(() => db.getActiveSessionId()));
  ipcMain.handle("sessions:setActive", (_event, id: string | null) => safe(() => db.setActiveSessionId(id)));
  ipcMain.handle("cards:add", (_event, input: Parameters<TandemDatabase["addOutputCard"]>[0]) =>
    safe(() => db.addOutputCard(input))
  );
  ipcMain.handle("composer:send", (_event, input: ComposerMessageInput) =>
    safe(() => {
      agents.submit(input.target, input.text);
      addUsageEstimate(input.sessionId, input.target, "input", input.text, "composer");
      return db.addComposerMessage(input);
    })
  );
  ipcMain.handle(
    "handoffs:createDraft",
    (_event, sessionId: string, fromSide: AgentSide, fromRole: string, toSide: AgentSide, toRole: string) =>
      safe(() => db.createHandoffDraft(sessionId, fromSide, fromRole, toSide, toRole))
  );
  ipcMain.handle("handoffs:approve", (_event, handoffId: string) => safe(() => approveAndSendHandoff(handoffId)));
  ipcMain.handle("evidence:updateStatus", (_event, sessionId: string, key: string, status: EvidenceStatus, ref?: string) =>
    safe(() => db.setEvidenceStatus(sessionId, key, status, ref))
  );
  ipcMain.handle("evidence:addRecord", (_event, input: EvidenceRecordInput) =>
    safe(() => db.addEvidenceRecord(input))
  );
  ipcMain.handle("evidence:listRecords", (_event, sessionId: string) =>
    safe(() => db.listEvidenceRecords(sessionId))
  );
  ipcMain.handle("usage:list", (_event, sessionId: string) =>
    safe(() => {
      // Make the lazy list reflect in-memory accumulators too.
      flushUsageAccumulators();
      return db.listUsageEvents(sessionId);
    })
  );
  ipcMain.handle("usage:summary", (_event, sessionId: string) =>
    safe(() => {
      flushUsageAccumulators();
      return db.usageSummary(sessionId);
    })
  );
  ipcMain.handle(
    "workflow:recordTaskReview",
    (_event, sessionId: string, verdict: "ok" | "changes" | "blocked") =>
      safe(() => db.recordTaskReview(sessionId, verdict))
  );
  ipcMain.handle("board:syncArtifact", (_event, sessionId: string) => safe(() => syncBoardArtifact(sessionId)));
  ipcMain.handle("board:getArtifact", (_event, sessionId: string) => safe(() => db.boardArtifactForSession(sessionId)));
  ipcMain.handle("board:attachArtifact", (_event, sessionId: string, repo: string, issueNumber: number) =>
    safe(() => attachGithubIssue(sessionId, repo, issueNumber))
  );
  ipcMain.handle("board:createSessionFromArtifact", (_event, sourceSessionId: string, repo: string, issueNumber: number) =>
    safe(() => createSessionFromGithubIssue(sourceSessionId, repo, issueNumber))
  );
  ipcMain.handle(
    "board:createTask",
    (_event, sessionId: string, input: { title?: string; body?: string; repo?: string; labels?: string[] }) =>
      safe(() => createTaskForSession(sessionId, input ?? {}))
  );
  ipcMain.handle("board:updateArtifactBody", (_event, sessionId: string, body: string) =>
    safe(() => updateBoardArtifactBody(sessionId, body))
  );
  ipcMain.handle("board:commentArtifact", (_event, sessionId: string, body: string) =>
    safe(() => commentBoardArtifact(sessionId, body))
  );
  ipcMain.handle("board:updateStatus", (_event, sessionId: string, status: string, slot?: BoardStatusSlot) =>
    safe(() => updateProjectStatus(sessionId, status, slot))
  );
  ipcMain.handle("board:authStatus", () => safe(() => board.authStatus()));
  ipcMain.handle("board:connect", () => safe(() => board.connect()));
  ipcMain.handle("board:listProjects", () => safe(() => board.listProjects()));
  ipcMain.handle("board:listProjectOwners", () => safe(() => board.listProjectOwners()));
  ipcMain.handle("board:createProject", (_event, owner: string, title: string) =>
    safe(() => board.createProject(owner, title))
  );
  ipcMain.handle("board:listWorkspaceRepos", (_event, workspaceRoot: string) => safe(() => board.listWorkspaceRepos(workspaceRoot)));
  ipcMain.handle("board:listArtifacts", (_event, owner: string, projectNumber: number) =>
    safe(() => board.listArtifacts(owner, projectNumber))
  );
  ipcMain.handle("board:listWorkspaceArtifacts", (_event, workspaceName?: string) =>
    safe(() => listWorkspaceBoardArtifacts(workspaceName))
  );
  ipcMain.handle("board:validateJira", (_event, input: { siteUrl: string; email: string; apiToken: string }) =>
    safe(() => validateJiraBoard(input))
  );
  ipcMain.handle("jira:listProjects", (_event, creds: { siteUrl: string; email: string; apiToken: string }) =>
    safe(() => new JiraService(creds).listProjects())
  );
  ipcMain.handle(
    "jira:createProject",
    (_event, creds: { siteUrl: string; email: string; apiToken: string }, input: { key: string; name: string }) =>
      safe(() => new JiraService(creds).createProject(input))
  );
  ipcMain.handle("jira:listProjectsForWorkspace", (_event, workspaceName?: string) =>
    safe(() => jiraServiceForWorkspace(workspaceName).listProjects())
  );
  ipcMain.handle("jira:createProjectForWorkspace", (_event, workspaceName: string, input: { key: string; name: string }) =>
    safe(() => jiraServiceForWorkspace(workspaceName).createProject(input))
  );
  ipcMain.handle(
    "jira:listProjectStatuses",
    (_event, creds: { siteUrl: string; email: string; apiToken: string }, projectKey: string, issueType?: string) =>
      safe(() => new JiraService(creds).listProjectStatuses(projectKey, issueType))
  );
  ipcMain.handle(
    "jira:listProjectStatusesForWorkspace",
    (_event, workspaceName: string, projectKey: string, issueType?: string) =>
      safe(() => jiraServiceForWorkspace(workspaceName).listProjectStatuses(projectKey, issueType))
  );
  ipcMain.handle("github:syncIssue", (_event, sessionId: string) => safe(() => syncBoardArtifact(sessionId)));
  ipcMain.handle("github:attachIssue", (_event, sessionId: string, repo: string, issueNumber: number) =>
    safe(() => attachGithubIssue(sessionId, repo, issueNumber))
  );
  ipcMain.handle("github:updateProjectStatus", (_event, sessionId: string, status: string) =>
    safe(() => updateProjectStatus(sessionId, status))
  );
  ipcMain.handle("github:authStatus", () => safe(() => board.authStatus()));
  ipcMain.handle("github:login", () => safe(() => board.connect()));
  ipcMain.handle("github:listProjects", () => safe(() => board.listProjects()));
  ipcMain.handle("github:listProjectOwners", () => safe(() => board.listProjectOwners()));
  ipcMain.handle("github:createProject", (_event, owner: string, title: string) =>
    safe(() => board.createProject(owner, title))
  );
  ipcMain.handle("github:listWorkspaceRepos", (_event, workspaceRoot: string) => safe(() => board.listWorkspaceRepos(workspaceRoot)));
  ipcMain.handle("github:listRepos", (_event, owner: string, limit?: number) => safe(() => github.listAccountRepos(owner, limit)));
  ipcMain.handle("github:createRepo", (_event, owner: string, name: string, isPrivate: boolean) =>
    safe(() => github.createRepo(owner, name, isPrivate))
  );
  ipcMain.handle("github:inspectGitRepo", (_event, path: string) => safe(() => github.inspectGitRepo(path)));
  ipcMain.handle("github:linkRemote", (_event, path: string, owner: string, name: string) =>
    safe(() => github.linkRemote(path, owner, name))
  );
  ipcMain.handle("github:gitStatusShort", (_event, path: string) => safe(() => github.gitStatusShort(path)));
  ipcMain.handle("github:initialPush", (_event, path: string, message?: string) => safe(() => github.initialPush(path, message)));
  ipcMain.handle("config:pickWorkspaceSubdirectory", (_event, root: string) => safe(() => pickWorkspaceSubdirectory(root)));
  ipcMain.handle("system:checkCommand", (_event, command: string) => safe(() => checkCommand(command)));
  ipcMain.handle("signals:poll", (_event, sessionId: string) => safe(() => pollAgentSignals(sessionId)));
  ipcMain.handle("signals:clear", (_event, sessionId: string, side?: AgentSide) =>
    safe(() => clearAgentSignals(sessionId, side))
  );
  ipcMain.handle("signals:readIdeaBody", (_event, sessionId: string, consume?: boolean) =>
    safe(() => readIdeaBody(sessionId, consume))
  );
  ipcMain.handle("workflow:requestTaskReview", (_event, sessionId: string, commentBody?: string) =>
    safe(() => requestTaskReview(sessionId, commentBody))
  );
  ipcMain.handle("workflow:applyTaskReviewVerdict", (_event, sessionId: string, verdict: TaskReviewVerdict, commentBody?: string) =>
    safe(() => applyTaskReviewVerdict(sessionId, verdict, commentBody))
  );
  ipcMain.handle("workflow:transition", (_event, sessionId: string, target: WorkflowTransitionTarget) =>
    safe(() => transitionWorkflow(sessionId, target))
  );
  ipcMain.handle("workflow:deployUat", (_event, sessionId: string) => safe(() => deployUat(sessionId)));
  ipcMain.handle("workflow:createFollowUpTasks", (_event, sourceSessionId: string, tasks: ProposedTask[]) =>
    safe(() => createFollowUpTasks(sourceSessionId, tasks))
  );
  ipcMain.handle(
    "conductor:update",
    (_event, sessionId: string, patch: Parameters<TandemDatabase["updateConductorState"]>[1]) =>
      safe(() => db.updateConductorState(sessionId, patch))
  );
  ipcMain.handle(
    "agents:start",
    (
      _event,
      side: AgentSide,
      command?: string,
      args?: string[],
      cwd?: string,
      sessionId?: string,
      role?: string,
      provider?: string,
      nativeSessionId?: string,
      nativeSessionName?: string,
      resumeCommand?: string,
      resumeArgs?: string[]
    ) =>
      safe(() => {
      const fallback = agents.defaultShell();
      const resolvedCommand = command || fallback.command;
      const resolvedArgs = args || fallback.args;
      const resolvedCwd = cwd || fallback.cwd;
      if (!existsSync(resolvedCwd)) {
        throw new Error(`Working directory does not exist: ${resolvedCwd}`);
      }
      if (sessionId) {
        const detail = db.getSession(sessionId);
        const config = loadTandemConfig();
        const workspace = activeWorkspace(config, detail?.session.workspaceName);
        const workspaceRoot = workspace?.root?.trim();
        if (!workspaceRoot || !existsSync(workspaceRoot)) {
          throw new Error(`No valid workspace root configured for session ${sessionId}.`);
        }
        if (!isPathInside(resolvedCwd, workspaceRoot)) {
          throw new Error(
            `Refusing to start agent outside the active workspace. cwd=${resolvedCwd}; workspace=${workspaceRoot}`
          );
        }
      }
      ensureTwindemExcluded(resolvedCwd);
      ensureSignalWritePermissions(resolvedCwd);
      const runId = agents.start(side, resolvedCommand, resolvedArgs, resolvedCwd, sessionId, agentEnvForProvider(provider));
      if (sessionId) {
        db.startAgentRun(
          runId,
          sessionId,
          side,
          role || "Agent",
          provider || resolvedCommand,
          resolvedCommand,
          resolvedCwd,
          nativeSessionId,
          nativeSessionName,
          resumeCommand,
          resumeArgs
        );
        registerUsageRun(runId, sessionId, side, provider);
      }
      return runId;
    })
  );
  ipcMain.handle("agents:isRunning", (_event, side: AgentSide) => safe(() => agents.isRunning(side)));
  ipcMain.handle("agents:runningSession", (_event, side: AgentSide) => safe(() => agents.runningSession(side)));
  ipcMain.handle("agents:write", (_event, side: AgentSide, data: string) => safe(() => agents.write(side, data)));
  ipcMain.handle("agents:resize", (_event, side: AgentSide, cols: number, rows: number) =>
    safe(() => agents.resize(side, cols, rows))
  );
  ipcMain.handle("agents:stop", (_event, side: AgentSide) => safe(() => agents.stop(side)));
  ipcMain.handle("agents:clearResume", (_event, sessionId: string, side: AgentSide) =>
    safe(() => db.clearAgentResume(sessionId, side))
  );
  ipcMain.handle("agents:restart", (
    _event,
    side: AgentSide,
    command?: string,
    args?: string[],
    cwd?: string,
    sessionId?: string,
    role?: string,
    provider?: string,
    nativeSessionId?: string,
    nativeSessionName?: string,
    resumeCommand?: string,
    resumeArgs?: string[]
  ) => {
    return safe(() => {
      const fallback = agents.defaultShell();
      const resolvedCommand = command || fallback.command;
      const resolvedArgs = args || fallback.args;
      const resolvedCwd = cwd || fallback.cwd;
      if (!existsSync(resolvedCwd)) {
        throw new Error(`Working directory does not exist: ${resolvedCwd}`);
      }
      if (sessionId) {
        const detail = db.getSession(sessionId);
        const config = loadTandemConfig();
        const workspace = activeWorkspace(config, detail?.session.workspaceName);
        const workspaceRoot = workspace?.root?.trim();
        if (!workspaceRoot || !existsSync(workspaceRoot)) {
          throw new Error(`No valid workspace root configured for session ${sessionId}.`);
        }
        if (!isPathInside(resolvedCwd, workspaceRoot)) {
          throw new Error(
            `Refusing to restart agent outside the active workspace. cwd=${resolvedCwd}; workspace=${workspaceRoot}`
          );
        }
      }
      ensureTwindemExcluded(resolvedCwd);
      ensureSignalWritePermissions(resolvedCwd);
      const runId = agents.restart(side, resolvedCommand, resolvedArgs, resolvedCwd, sessionId, agentEnvForProvider(provider));
      if (sessionId) {
        db.startAgentRun(
          runId,
          sessionId,
          side,
          role || "Agent",
          provider || resolvedCommand,
          resolvedCommand,
          resolvedCwd,
          nativeSessionId,
          nativeSessionName,
          resumeCommand,
          resumeArgs
        );
        registerUsageRun(runId, sessionId, side, provider);
      }
      return runId;
    });
  });
}

async function checkCommand(command: string): Promise<CommandCheckResult> {
  const normalized = command.trim();
  if (!normalized) {
    return { ok: false, command, message: "Command is required." };
  }

  try {
    const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${shellQuote(normalized)}`], {
      env: { ...process.env, PATH: expandedPath() }
    });
    const path = stdout.trim().split("\n")[0];
    return {
      ok: true,
      command: normalized,
      path,
      message: `${normalized} found${path ? ` at ${path}` : ""}.`
    };
  } catch {
    return {
      ok: false,
      command: normalized,
      message: `${normalized} was not found in PATH. Install it or use the full command path.`
    };
  }
}

function agentEnvForProvider(providerKey?: string): Record<string, string> {
  if (!providerKey) return {};
  const provider = loadTandemConfig().providers[providerKey];
  if (!provider || provider.authMode !== "api_key") return {};
  const secretRef = provider.apiKeySecretRef?.trim();
  const envName = provider.apiKeyEnv?.trim() || apiKeyEnvForProvider(provider.command, provider.label);
  if (!secretRef || !envName) {
    throw new Error(`Agent profile "${provider.label}" is set to API key auth but has no secret reference.`);
  }
  const value = readAgentApiKeySecret(secretRef);
  if (!value) {
    throw new Error(`Agent profile "${provider.label}" is set to API key auth but no API key is saved.`);
  }
  return { [envName]: value };
}

function apiKeyEnvForProvider(command?: string, label?: string): string | undefined {
  const text = `${command ?? ""} ${label ?? ""}`.toLowerCase();
  if (text.includes("codex") || text.includes("openai")) return "OPENAI_API_KEY";
  if (text.includes("claude") || text.includes("anthropic")) return "ANTHROPIC_API_KEY";
  return undefined;
}

function secretsDir(): string {
  const dir = join(app.getPath("userData"), "secrets");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function secretPath(ref: string): string {
  const safeRef = ref.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(secretsDir(), `${safeRef}.bin`);
}

function setAgentApiKeySecret(ref: string, value: string): boolean {
  const trimmed = value.trim();
  if (!ref.trim()) throw new Error("Secret reference is required.");
  if (!trimmed) {
    clearAgentApiKeySecret(ref);
    return false;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage encryption is not available on this machine.");
  }
  const encrypted = safeStorage.encryptString(trimmed);
  writeFileSync(secretPath(ref), encrypted);
  return true;
}

function readAgentApiKeySecret(ref: string): string | null {
  const path = secretPath(ref);
  if (!existsSync(path)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage encryption is not available on this machine.");
  }
  return safeStorage.decryptString(readFileSync(path));
}

function hasAgentApiKeySecret(ref: string): boolean {
  return existsSync(secretPath(ref));
}

function clearAgentApiKeySecret(ref: string): boolean {
  const path = secretPath(ref);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

async function validateAgentApiKey(envName: string, value: string): Promise<{ ok: boolean; provider: string; message: string }> {
  const key = value.trim();
  const normalizedEnv = envName.trim();
  if (!key) return { ok: false, provider: normalizedEnv || "unknown", message: "API key is required." };
  if (normalizedEnv === "OPENAI_API_KEY") {
    const result = await requestJsonStatus({
      hostname: "api.openai.com",
      path: "/v1/models",
      headers: { Authorization: `Bearer ${key}` }
    });
    return result.ok
      ? { ok: true, provider: "OpenAI", message: "OpenAI API key is valid." }
      : { ok: false, provider: "OpenAI", message: `OpenAI API key check failed (${result.status}): ${result.message}` };
  }
  if (normalizedEnv === "ANTHROPIC_API_KEY") {
    const result = await requestJsonStatus({
      hostname: "api.anthropic.com",
      path: "/v1/models",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      }
    });
    return result.ok
      ? { ok: true, provider: "Anthropic", message: "Anthropic API key is valid." }
      : { ok: false, provider: "Anthropic", message: `Anthropic API key check failed (${result.status}): ${result.message}` };
  }
  return { ok: false, provider: normalizedEnv || "unknown", message: `Unsupported API key env var: ${normalizedEnv}` };
}

async function validateJiraBoard(input: { siteUrl: string; email: string; apiToken: string }): Promise<{ ok: boolean; message: string }> {
  const siteUrl = input.siteUrl.trim();
  const email = input.email.trim();
  const apiToken = input.apiToken.trim();
  if (!siteUrl || !email || !apiToken) {
    return { ok: false, message: "Jira site URL, email, and API token are required." };
  }
  try {
    const jira = new JiraService({ siteUrl, email, apiToken });
    return await jira.authStatus();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// Build a JiraService for a workspace whose token is already saved in safeStorage (Settings path).
// Mirrors the Jira branch of listWorkspaceBoardArtifacts; never sends the token to the renderer.
function jiraServiceForWorkspace(workspaceName?: string): JiraService {
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, workspaceName);
  if (!workspace?.jiraSiteUrl?.trim() || !workspace.jiraEmail?.trim()) {
    throw new Error("Jira is not configured for this project. Set the site URL and email in Settings → Board.");
  }
  if (!workspace.jiraApiTokenSecretRef?.trim()) {
    throw new Error("Jira API token is not saved. Paste and save it in Settings → Board.");
  }
  const apiToken = readAgentApiKeySecret(workspace.jiraApiTokenSecretRef);
  if (!apiToken) throw new Error("Jira API token is missing from safeStorage. Paste and save it again in Settings → Board.");
  return new JiraService({ siteUrl: workspace.jiraSiteUrl, email: workspace.jiraEmail, apiToken });
}

// Close a Jira issue the way GitHub deletion closes an issue: move it to a final status. Tries the
// cancelled-family first (Won't Do / Cancelled), then Done. Returns the status name applied, or null
// if the workflow has none of them. Needs only transition rights — never "Delete issues".
async function closeJiraIssueToFinal(
  jira: JiraService,
  issueKey: string,
  workspace?: TandemConfig["workspaces"][number]
): Promise<string | null> {
  for (const slot of ["wont_do", "done"] as const) {
    for (const candidate of boardStatusCandidatesForSlot(slot, workspace)) {
      if (await jira.transitionIssue(issueKey, candidate)) return candidate;
    }
  }
  return null;
}

async function listWorkspaceBoardArtifacts(workspaceName?: string): Promise<BoardArtifactOption[]> {
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, workspaceName);
  const provider = boardProviderForWorkspace(config, workspace);
  if (!workspace || provider === "none") return [];
  if (provider === "jira") {
    if (!workspace.jiraSiteUrl?.trim() || !workspace.jiraProjectKey?.trim() || !workspace.jiraEmail?.trim()) {
      throw new Error("Jira board is not fully configured. Set site URL, project key, and email in Settings → Board.");
    }
    if (!workspace.jiraApiTokenSecretRef?.trim()) {
      throw new Error("Jira API token is not saved. Paste and save it in Settings → Board.");
    }
    const apiToken = readAgentApiKeySecret(workspace.jiraApiTokenSecretRef);
    if (!apiToken) throw new Error("Jira API token is missing from safeStorage. Paste and save it again in Settings → Board.");
    const jira = new JiraService({
      siteUrl: workspace.jiraSiteUrl,
      email: workspace.jiraEmail,
      apiToken
    });
    return jira.listIssues(workspace.jiraProjectKey);
  }
  if (!workspace.githubOwner || !workspace.projectNumber) {
    throw new Error("GitHub Project board is not configured. Set owner and Project number in Settings → Board.");
  }
  return board.listArtifacts(workspace.githubOwner, workspace.projectNumber);
}

function requestJsonStatus(input: {
  hostname: string;
  path: string;
  headers: Record<string, string>;
}): Promise<{ ok: boolean; status: number; message: string }> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: input.hostname,
        path: input.path,
        method: "GET",
        timeout: 10000,
        headers: {
          Accept: "application/json",
          ...input.headers
        }
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            message: apiErrorMessage(body) || res.statusMessage || "No response body"
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out."));
    });
    req.on("error", (error) => {
      resolve({ ok: false, status: 0, message: error.message });
    });
    req.end();
  });
}

function apiErrorMessage(body: string): string {
  if (!body.trim()) return "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed.error?.message || parsed.message || "";
  } catch {
    return body.slice(0, 180);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

function approveAndSendHandoff(handoffId: string) {
  const handoff = db.getHandoff(handoffId);
  if (!handoff) throw new Error("Handoff not found");
  if (!handoff.toSide) throw new Error("Handoff has no target side");
  if (!agents.isRunning(handoff.toSide)) {
    throw new Error(`Cannot send handoff: side ${handoff.toSide} has no running agent.`);
  }
  const approved = db.approveHandoff(handoffId);
  if (!approved) throw new Error("Handoff not found");
  const detail = db.getSession(approved.sessionId);
  const config = loadTandemConfig();
  const payload = renderInstructionTemplate(
    instructionTemplate(
      config,
      detail?.session.workspaceName,
      "handoffReview",
      [
        "You are receiving a Twindem review briefing from the other agent.",
        "Treat the text below as the full task-review context. Review the board artifact first; do not start by searching the repository unless the artifact context is insufficient.",
        "",
        "{{summary}}",
        "",
        "Respond with one verdict: OK, Changes requested, or Blocked. If changes are required, provide a concise checklist.",
        "Finish with a structured result block:",
        'TWINDEM_RESULT: {"marker":"IDEA APPROVED|DOR MET|IMPLEMENTATION READY|CODE APPROVED","verdict":"OK|Changes requested|Blocked","summary":"...","nextAction":"..."}'
      ].join("\n")
    ),
    { summary: approved.summary }
  );
  agents.submit(approved.toSide!, payload);
  addUsageEstimate(approved.sessionId, approved.toSide!, "input", payload, "app");
  db.addSystemTranscript(approved.sessionId, `Approved handoff sent to side ${approved.toSide}`, approved.toSide);
  return approved;
}

async function pickDirectory(): Promise<string | null> {
  const options: OpenDialogOptions = {
    properties: ["openDirectory", "createDirectory"]
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

// Pick (or create) a subdirectory under the project root. Validated in MAIN (realpath/under-root) — the
// renderer never computes the relative path itself. Returns the absolute + relative path.
async function pickWorkspaceSubdirectory(
  root: string
): Promise<{ absolutePath: string; relativePath: string } | null> {
  const base = root.trim();
  if (!base || !existsSync(base)) throw new Error("Set the project folder first.");
  const realBase = realpathSync(base);
  const options: OpenDialogOptions = {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: realBase
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  const picked = realpathSync(result.filePaths[0]);
  const rel = relative(realBase, picked);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Pick a folder inside the project folder.");
  }
  return { absolutePath: picked, relativePath: rel.split("\\").join("/") };
}

async function pickFiles(defaultPath?: string): Promise<string[] | null> {
  const options: OpenDialogOptions = {
    properties: ["openFile", "multiSelections"],
    // Start the dialog in the project folder so attaching a design/file lands where the work is.
    ...(defaultPath?.trim() && existsSync(defaultPath.trim()) ? { defaultPath: defaultPath.trim() } : {})
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths;
}

// Copy user-picked files into the workspace's .twindem/attachments/<slug>/ so the LOCAL agents can
// inspect them (images are viewable by the agent CLIs; archives can be unzipped and reviewed).
// Returns workspace-relative paths, or [] when there's nothing/nowhere to copy.
function importSessionAttachments(workspaceRoot: string | undefined, sourcePaths: string[]): string[] {
  if (!workspaceRoot?.trim() || sourcePaths.length === 0) return [];
  const slug = randomUUID().slice(0, 8);
  const relativeDir = join(".twindem", "attachments", slug);
  const absoluteDir = join(workspaceRoot, relativeDir);
  const copied: string[] = [];
  try {
    mkdirSync(absoluteDir, { recursive: true });
  } catch {
    return [];
  }
  for (const source of sourcePaths) {
    try {
      const name = basename(source);
      copyFileSync(source, join(absoluteDir, name));
      copied.push(join(relativeDir, name));
    } catch {
      /* skip unreadable file */
    }
  }
  return copied;
}

async function importConfigFile(): Promise<TandemConfig | null> {
  const options: OpenDialogOptions = {
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  return saveUserTandemConfig(readTandemConfigFile(result.filePaths[0]));
}

async function exportConfigFile(config: TandemConfig): Promise<string | null> {
  const options: SaveDialogOptions = {
    defaultPath: "twindem-config.json",
    filters: [{ name: "JSON", extensions: ["json"] }]
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  writeTandemConfigFile(result.filePath, config);
  return result.filePath;
}

async function downloadSession(id: string): Promise<string | null> {
  const detail = db.getSession(id);
  if (!detail) throw new Error("Session not found");
  const options: SaveDialogOptions = {
    defaultPath: `${safeFilename(detail.session.title)}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }]
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  writeFileSync(result.filePath, sessionMarkdown(detail), "utf8");
  return result.filePath;
}

async function syncBoardArtifact(sessionId: string): Promise<GitHubIssueContext> {
  const detail = requireIssueSession(sessionId);
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  const issue = await board.getArtifact(
    detail.session.repo!,
    detail.session.issueNumber!,
    workspace?.githubOwner,
    workspace?.projectNumber
  );
  db.saveGithubCache(sessionId, issue, workspace);
  db.addWorkflowEvent(sessionId, "github.sync_issue", "app", "ok", undefined, undefined, false);
  return issue;
}

async function attachGithubIssue(sessionId: string, repo: string, issueNumber: number): Promise<SessionDetail> {
  const detail = db.getSession(sessionId);
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, detail?.session.workspaceName);
  const issue = await board.getArtifact(repo, issueNumber, workspace?.githubOwner, workspace?.projectNumber);
  db.linkGithubIssue(sessionId, issue, workspace);
  db.saveGithubCache(sessionId, issue, workspace);
  return db.getSession(sessionId)!;
}

// Agents create .twindem/ scratch files (signals, idea bodies) inside the workspace root. If that
// root is a git repo, keep the litter out of its history WITHOUT touching the repo's .gitignore:
// .git/info/exclude is local-only. Best-effort, once per process per root.
const twindemExcludedRoots = new Set<string>();
function ensureTwindemExcluded(root: string): void {
  if (twindemExcludedRoots.has(root)) return;
  twindemExcludedRoots.add(root);
  try {
    const excludePath = join(root, ".git", "info", "exclude");
    if (!existsSync(join(root, ".git"))) return;
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (!current.split("\n").some((line) => line.trim() === ".twindem/")) {
      appendFileSync(excludePath, `${current.endsWith("\n") || !current ? "" : "\n"}.twindem/\n`, "utf8");
    }
  } catch {
    /* best-effort */
  }
}

// The signal protocol asks agents to WRITE files — without a standing permission, the Claude Code
// CLI stops at "Do you want to create <sessionId>.A2.json?" and the whole loop hangs on a hidden
// prompt. Pre-approve ONLY .twindem/** writes via the workspace's .claude/settings.local.json
// (Claude Code's local, non-versioned settings file); everything else stays gated.
const signalPermissionRoots = new Set<string>();
function ensureSignalWritePermissions(root: string): void {
  if (signalPermissionRoots.has(root)) return;
  signalPermissionRoots.add(root);
  try {
    const dir = join(root, ".claude");
    const path = join(dir, "settings.local.json");
    let settings: { permissions?: { allow?: string[] } & Record<string, unknown> } & Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        settings = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return; // don't clobber a file we can't parse
      }
    }
    const allow = settings.permissions?.allow ?? [];
    const rules = ["Write(.twindem/**)", "Edit(.twindem/**)"];
    const missing = rules.filter((rule) => !allow.includes(rule));
    if (missing.length === 0) return;
    settings.permissions = { ...settings.permissions, allow: [...allow, ...missing] };
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

// Agents signal end-of-step by WRITING a file (.twindem/signals/<sessionId>.<A1|A2>.json) instead
// of printing a marker line: the TUI echoes injected prompts and wraps long lines, so scraping
// markers from the byte stream caused phantom handoffs (infinite review/fix loops).
const SIGNAL_SUFFIXES: Array<{ suffix: string; side: AgentSide }> = [
  { suffix: "A1", side: "L" },
  { suffix: "A2", side: "R" }
];

// Session ids are main-generated UUIDs; enforce the shape before using one in a path (defense in
// depth against traversal if ids ever become importable).
function isSafeSessionId(sessionId: string): boolean {
  return /^[0-9a-zA-Z-]{8,64}$/.test(sessionId);
}

// The poller hits this every 1.2s; resolving it from scratch means a full session hydration plus a
// config read+parse from disk each tick. Cache per session, invalidated on config/session changes.
const signalsDirCache = new Map<string, string | null>();
function invalidateSignalsDirCache(): void {
  signalsDirCache.clear();
}

function sessionSignalsDir(sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const cached = signalsDirCache.get(sessionId);
  if (cached !== undefined) return cached;
  const detail = db.getSession(sessionId);
  if (!detail) return null;
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  const dir = workspace?.root ? join(workspace.root, ".twindem", "signals") : null;
  signalsDirCache.set(sessionId, dir);
  return dir;
}

function normalizeSignalVerdict(value: unknown): AgentSignalVerdict | undefined {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "ok") return "OK";
  if (v === "changes requested" || v === "changes") return "Changes requested";
  if (v === "blocked") return "Blocked";
  return undefined;
}

// Read and CONSUME (delete) any pending signal files for this session. Tolerates agents wrapping
// the JSON in a code fence or extra prose by extracting the first {...} object. Parse-then-delete:
// a file we couldn't parse is NOT consumed immediately — the agent may still be mid-write — but
// after a few failed polls it is dropped (and logged) so junk can't wedge the poller forever.
const signalParseFailures = new Map<string, number>();
const DUPLICATE_SIGNAL_WINDOW_MS = 10 * 60 * 1000;
const recentSignalHashes = new Map<string, { hash: string; at: number }>();

function signalPayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pollAgentSignals(sessionId: string): AgentSignal[] {
  const dir = sessionSignalsDir(sessionId);
  if (!dir) return [];
  const signals: AgentSignal[] = [];
  for (const { suffix, side } of SIGNAL_SUFFIXES) {
    const path = join(dir, `${sessionId}.${suffix}.json`);
    if (!existsSync(path)) continue;
    try {
      // A very fresh file is probably still being written — pick it up next tick.
      if (Date.now() - statSync(path).mtimeMs < 400) continue;
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    let parsed: { phase?: unknown; verdict?: unknown; status?: unknown; findings?: unknown; tasks?: unknown } | null = null;
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]) as { phase?: unknown; verdict?: unknown; status?: unknown; findings?: unknown; tasks?: unknown };
      } catch {
        parsed = null;
      }
    }
    const phase = parsed ? String(parsed.phase ?? "").trim().toLowerCase() : "";
    if (!parsed || !phase) {
      const failures = (signalParseFailures.get(path) ?? 0) + 1;
      if (failures >= 4) {
        signalParseFailures.delete(path);
        try {
          unlinkSync(path);
        } catch {
          /* leave it; next poll retries the delete */
        }
        db.addWorkflowEvent(sessionId, `signal.malformed.${suffix}`, "agent", "warned", undefined, undefined, true);
      } else {
        signalParseFailures.set(path, failures);
      }
      continue;
    }
    signalParseFailures.delete(path);
    try {
      unlinkSync(path);
    } catch {
      // If we can't delete it we'd re-fire the same signal forever — skip it instead.
      continue;
    }
    const verdict = normalizeSignalVerdict(parsed.verdict);
    const status = typeof parsed.status === "string" ? parsed.status.trim() : undefined;
    const findings = normalizeSignalFindings(parsed.findings);
    const tasks = normalizeSignalTasks(parsed.tasks);
    const shouldDedupe = (phase === "review" && Boolean(verdict)) || (phase === "tasks" && Boolean(tasks?.length));
    if (shouldDedupe) {
      const signalHash = signalPayloadHash({ phase, verdict, status, findings, tasks });
      const dedupeKey = `${sessionId}:${suffix}:${phase}`;
      const previous = recentSignalHashes.get(dedupeKey);
      if (previous?.hash === signalHash && Date.now() - previous.at < DUPLICATE_SIGNAL_WINDOW_MS) {
        db.addWorkflowEvent(sessionId, `signal.duplicate.${suffix}`, "agent", "warned", undefined, verdict ? `${phase} | ${verdict}` : phase, false);
        continue;
      }
      recentSignalHashes.set(dedupeKey, { hash: signalHash, at: Date.now() });
    }
    signals.push({ side, phase, verdict, status, findings, tasks });
    db.addWorkflowEvent(sessionId, `signal.consumed.${suffix}`, "agent", "ok", undefined, verdict ? `${phase} | ${verdict}` : phase, false);
    recordSignalEvidence(sessionId, side, phase, verdict, findings, tasks);
  }
  return signals;
}

// Tolerant normalization of the findings array agents write into the review signal file. Junk
// entries are dropped; missing ids become F<n>; anything not clearly non-blocking is blocking
// (fail-closed: an unlabeled finding must not silently skip the corrections round).
// Exported for regression tests only.
export function normalizeSignalFindings(value: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const findings: ReviewFinding[] = [];
  value.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const entry = item as Record<string, unknown>;
    const title = String(entry.title ?? entry.summary ?? "").trim();
    const detail = String(entry.detail ?? entry.description ?? "").trim();
    if (!title && !detail) return;
    findings.push({
      id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `F${index + 1}`,
      severity: String(entry.severity ?? "").toLowerCase().startsWith("non") ? "non_blocking" : "blocking",
      file: typeof entry.file === "string" && entry.file.trim() ? entry.file.trim() : undefined,
      line: typeof entry.line === "number" && Number.isFinite(entry.line) ? entry.line : undefined,
      title: title || detail.slice(0, 80),
      detail: detail || title,
      status: "open"
    });
  });
  return findings.length > 0 ? findings : undefined;
}

function compactSignalText(value: unknown, maxLength: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function proposedTaskFingerprint(title: string, type: ProposedTask["type"]): string {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}::${type}`;
}

export function normalizeSignalTasks(value: unknown): ProposedTask[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tasks: ProposedTask[] = [];
  value.slice(0, 20).forEach((item) => {
    if (!item || typeof item !== "object") return;
    const entry = item as Record<string, unknown>;
    const title = compactSignalText(entry.title, 120);
    const summary = compactSignalText(entry.summary ?? entry.description ?? entry.body, 2000);
    if (!title || !summary) return;
    const rawType = String(entry.type ?? "").toLowerCase();
    const validTypes = new Set<ProposedTask["type"]>(["feature", "bug", "spike", "architecture", "research", "runbook"]);
    const type: ProposedTask["type"] = validTypes.has(rawType as ProposedTask["type"])
      ? (rawType as ProposedTask["type"])
      : rawType === "spike" || (!rawType && /\bspike|proof of concept|poc|prototype|feasibility\b/i.test(`${title} ${summary}`))
        ? "spike"
        : rawType === "bug" || (!rawType && /\bbug|fix|regression|error|crash\b/i.test(`${title} ${summary}`))
        ? "bug"
        : "feature";
    tasks.push({
      id: `T${tasks.length + 1}`,
      status: "proposed",
      title,
      type,
      summary,
      acceptanceCriteria: compactSignalText(entry.acceptanceCriteria ?? entry.acceptance_criteria ?? "", 2000) || undefined,
      targetRepo: compactSignalText(entry.targetRepo ?? entry.target_repo ?? "", 180) || undefined,
      fingerprint: proposedTaskFingerprint(title, type)
    });
  });
  return tasks.length > 0 ? tasks : undefined;
}

// Per the audit-vs-evidence criterion, only signals that mark an artifact or decision become
// narrative evidence; bookkeeping signals (status proposal, task-creation request) stay audit-only.
function recordSignalEvidence(
  sessionId: string,
  side: AgentSide,
  phase: string,
  verdict?: AgentSignalVerdict,
  findings?: ReviewFinding[],
  tasks?: ProposedTask[]
): void {
  const agentLabel = side === "L" ? "Agent 1" : "Agent 2";
  if (phase === "ready" || phase === "analysis" || phase === "implementation") {
    db.recordWorkflowEvidence(
      sessionId,
      "artifact",
      `${agentLabel} signaled work ready`,
      `${agentLabel} signaled that its work product for the current phase is ready for review.`,
      { source: "agent", agentSide: side }
    );
  } else if (phase === "review" && verdict) {
    const blocking = findings?.filter((finding) => finding.severity === "blocking").length ?? 0;
    db.recordWorkflowEvidence(
      sessionId,
      "review",
      `${agentLabel} review verdict: ${verdict}`,
      findings && findings.length > 0
        ? `${agentLabel} finished its review with the verdict "${verdict}" and ${findings.length} structured finding${findings.length === 1 ? "" : "s"} (${blocking} blocking): ${findings.map((finding) => `${finding.id} ${finding.title}`).join("; ")}.`
        : `${agentLabel} finished its review and returned the verdict "${verdict}".`,
      { source: "agent", agentSide: side, details: findings ? { findings } : undefined }
    );
  } else if (phase === "deployed" || phase === "released" || phase === "rollback") {
    const what = phase === "deployed" ? "a UAT deploy" : phase === "released" ? "a production release" : "a rollback";
    db.recordWorkflowEvidence(
      sessionId,
      "deploy",
      `${agentLabel} completed ${what}`,
      `${agentLabel} signaled that ${what} for this task completed. Evidence details are in the issue comments.`,
      { source: "agent", agentSide: side }
    );
  } else if (phase === "tasks" && tasks && tasks.length > 0) {
    db.recordWorkflowEvidence(
      sessionId,
      "follow_up",
      "Follow-up task proposal",
      `Agent 1 proposed ${tasks.length} follow-up task${tasks.length === 1 ? "" : "s"} derived from the approved ADR.`,
      { source: "agent", agentSide: side, details: { tasks } }
    );
  }
}

// The agent also writes its latest task body to .twindem/ideas/<sessionId>.md (sibling of the
// signals dir). Read it WITHOUT consuming so "Update task ← A1" has a reliable source besides the
// scraped TWINDEM_BODY chat block.
function readIdeaBody(sessionId: string, consume = false): string | null {
  const signalsDir = sessionSignalsDir(sessionId);
  if (!signalsDir) return null;
  const path = join(dirname(signalsDir), "ideas", `${sessionId}.md`);
  if (!existsSync(path)) return null;
  try {
    const contents = readFileSync(path, "utf8").trim();
    if (consume && contents) {
      try {
        unlinkSync(path);
      } catch {
        /* best-effort: worst case the same body gets deduped by the caller */
      }
    }
    return contents || null;
  } catch {
    return null;
  }
}

function clearAgentSignals(sessionId: string, side?: AgentSide): void {
  const dir = sessionSignalsDir(sessionId);
  if (!dir) return;
  for (const { suffix, side: fileSide } of SIGNAL_SUFFIXES) {
    if (side && side !== fileSide) continue;
    const path = join(dir, `${sessionId}.${suffix}.json`);
    signalParseFailures.delete(path);
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
    } catch {
      /* best-effort */
    }
  }
}

// Create the board task for an idea session that does not have an issue yet,
// link it, add it to the Project and put it in Inbox. The issue link becomes the source of truth.
async function createTaskForSession(
  sessionId: string,
  input: { title?: string; body?: string; repo?: string; labels?: string[] }
): Promise<SessionDetail> {
  const detail = db.getSession(sessionId);
  if (!detail) throw new Error("Session not found.");
  if (detail.session.issueNumber || detail.session.boardItemId) throw new Error("This session already has a task.");

  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  if (!workspace) throw new Error("Workspace not found for this session.");
  const provider = boardProviderForWorkspace(config, workspace);
  const title = input.title?.trim() || detail.session.title;
  // Prefer the task body the agent wrote to a file — reliable, unlike scraping the TUI stream.
  // Fall back to the body scraped from the stream, then to the raw idea seed.
  const bodyPath = workspace.root ? join(workspace.root, ".twindem", "ideas", `${sessionId}.md`) : null;
  let fileBody: string | undefined;
  if (bodyPath && existsSync(bodyPath)) {
    try {
      const contents = readFileSync(bodyPath, "utf8").trim();
      if (contents) fileBody = contents;
    } catch {
      /* ignore unreadable body file */
    }
  }
  const rawBody = preserveAttachmentSection(
    fileBody || input.body?.trim() || detail.session.initialBody?.trim() || defaultIssueBody(title),
    detail.session.initialBody
  );
  // Attribution requirement: every task/comment ends with created/updated by <AI name + version>.
  const authorProvider = config.providers[detail.session.leftProvider ?? ""];
  const authorModel = authorProvider?.model?.split("—")[0]?.trim();
  const authorSig = `${authorProvider?.label ?? "AI agent"}${authorModel && !/^(default|CLI default)$/i.test(authorModel) ? ` (${authorModel})` : ""}`;
  const body = `${rawBody}\n\n---\n_created by ${authorSig} via Twindem_`;

  const labels = Array.from(new Set([...(input.labels ?? []), ...labelsForIdeaType(detail.session.ideaType)]));
  if (provider === "jira") {
    if (!workspace?.jiraProjectKey?.trim()) {
      throw new Error("Jira project is not configured for this workspace. Set it in Settings → Board.");
    }
    const jira = jiraServiceForWorkspace(workspace.name);
    const created = await jira.createIssue({
      projectKey: workspace.jiraProjectKey,
      issueType: workspace.jiraIssueType || "Task",
      title,
      body,
      labels
    });
    db.linkBoardItem(
      sessionId,
      {
        provider: "jira",
        id: created.id,
        key: created.key,
        title,
        body,
        url: created.url,
        status: boardStatusForSlot("inbox", workspace)
      },
      workspace
    );
    if (bodyPath && existsSync(bodyPath)) {
      try {
        unlinkSync(bodyPath);
      } catch {
        /* best-effort cleanup */
      }
    }
    db.addWorkflowEvent(sessionId, "task.created", "app", "ok", "idea", boardStatusForSlot("inbox", workspace), true);
    return db.getSession(sessionId)!;
  }
  if (provider === "none") {
    throw new Error("No board is configured for this workspace. Configure Jira or GitHub in Settings → Board before creating a board task.");
  }
  if (!workspace?.githubOwner || !workspace.projectNumber) {
    throw new Error(
      "GitHub Project board is not configured, so the task can't be placed on the board. " +
        "Set the GitHub owner and project number in Settings → Board, then create the task."
    );
  }
  const repo = input.repo?.trim() || detail.session.repo || workspace.issueRepository?.trim();
  if (!repo) {
    const draft = await board.createDraftArtifact(workspace.githubOwner, workspace.projectNumber, title, body);
    const inboxStatus = boardStatusForSlot("inbox", workspace);
    let statusSet = false;
    for (let attempt = 0; attempt < 4 && !statusSet; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800));
      statusSet = await board.updateProjectItemStatus(
        workspace.githubOwner,
        workspace.projectNumber,
        draft.id,
        boardStatusCandidatesForSlot("inbox", workspace)
      );
    }
    db.linkBoardDraft(sessionId, { ...draft, key: draft.id, status: statusSet ? inboxStatus : undefined }, workspace);
    if (bodyPath && existsSync(bodyPath)) {
      try {
        unlinkSync(bodyPath);
      } catch {
        /* best-effort cleanup */
      }
    }
    if (!statusSet) {
      db.addWorkflowEvent(sessionId, "github.project_status.warning", "app", "warned", undefined, inboxStatus, false);
    }
    db.addWorkflowEvent(sessionId, "task.created", "app", "ok", "idea", statusSet ? inboxStatus : "No status", true);
    return db.getSession(sessionId)!;
  }

  const created = await board.createArtifact(repo, title, body, labels);
  // Link the issue to the session IMMEDIATELY: if anything below throws, a retry must resume on
  // this issue (guarded by session.issueNumber above) instead of creating a duplicate.
  db.linkGithubIssue(sessionId, created, workspace);
  db.saveGithubCache(sessionId, created, workspace);
  if (bodyPath && existsSync(bodyPath)) {
    try {
      unlinkSync(bodyPath);
    } catch {
      /* best-effort cleanup */
    }
  }
  const addedToProject = await board.addArtifactToProject(workspace.githubOwner, workspace.projectNumber, created.url);
  const inboxStatus = boardStatusForSlot("inbox", workspace);
  // Setting the status right after adding can fail because the Project item is not queryable yet
  // (eventual consistency), which leaves the card at "No status". Retry a few times — but only
  // when the add itself succeeded; otherwise the retries can never find the item.
  let statusSet = false;
  if (addedToProject) {
    for (let attempt = 0; attempt < 6 && !statusSet; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
      statusSet = await board.updateStatus(
        workspace.githubOwner,
        workspace.projectNumber,
        repo,
        created.issueNumber,
        boardStatusCandidatesForSlot("inbox", workspace)
      );
    }
  } else {
    db.addWorkflowEvent(sessionId, "github.project_add.warning", "app", "warned", undefined, inboxStatus, false);
  }
  if (!statusSet) {
    db.addWorkflowEvent(sessionId, "github.project_status.warning", "app", "warned", undefined, inboxStatus, false);
  }
  const fresh = await board.getArtifact(repo, created.issueNumber, workspace.githubOwner, workspace.projectNumber);
  db.linkGithubIssue(sessionId, fresh, workspace);
  db.saveGithubCache(sessionId, fresh, workspace);
  db.addWorkflowEvent(sessionId, "task.created", "app", "ok", "idea", statusSet ? inboxStatus : "No status", true);
  return db.getSession(sessionId)!;
}

function boardArtifactRefForSession(session: { repo?: string; issueNumber?: number; boardItemKey?: string; boardItemId?: string }): string {
  if (session.repo && session.issueNumber) return `${session.repo}#${session.issueNumber}`;
  return session.boardItemKey || session.boardItemId || "local";
}

function followUpTaskBody(sourceSession: SessionDetail["session"], task: ProposedTask): string {
  const sourceAdrRef = boardArtifactRefForSession(sourceSession);
  const inheritedAttachments = attachmentSectionFromText(sourceSession.initialBody);
  return [
    task.summary,
    "",
    task.acceptanceCriteria ? `Acceptance criteria:\n${task.acceptanceCriteria}` : "",
    task.targetRepo ? `Target repo hint: ${task.targetRepo}` : "",
    inheritedAttachments
      ? ["Inherited design/reference attachments from source ADR:", inheritedAttachments].join("\n")
      : "",
    task.type === "spike"
      ? [
          "Spike output contract:",
          "- State the question being answered and the time/scope boundary.",
          "- Produce prototype or feasibility evidence, with exact files/commands/results when applicable.",
          "- Record findings, recommendation, risks, and follow-up tasks.",
          `- Update the source ADR (${sourceAdrRef}) with the spike conclusions before marking the spike done. If the ADR is a board issue, post a comment there; if the ADR lives in a repo doc, update that ADR document.`
        ].join("\n")
      : "",
    "",
    "---",
    `Derived from ADR: ${sourceAdrRef}`,
    `Source session: ${sourceSession.id}`,
    `Task id: ${task.id}`,
    `Task type: ${task.type}`,
    "_created by Twindem_"
  ].filter(Boolean).join("\n");
}

function attachmentSectionFromText(text?: string | null): string {
  const body = text?.trim();
  if (!body) return "";
  const match = body.match(/(?:^|\n)### Attachments[^\n]*\n([\s\S]*?)(?=\n### |\n---|\n## |$)/i);
  if (!match?.[1]) return "";
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .join("\n");
}

function preserveAttachmentSection(nextBody: string, originalBody?: string | null): string {
  const attachments = attachmentSectionFromText(originalBody);
  if (!attachments || /(?:^|\n)### Attachments/i.test(nextBody)) return nextBody;
  return `${nextBody.trim()}\n\n### Attachments (local files in the project root — agents must inspect these)\n${attachments}`;
}

function createdFollowUpItems(sourceSessionId: string): Array<{ taskId?: string; fingerprint?: string; boardRef?: string; url?: string }> {
  return db.listEvidenceRecords(sourceSessionId).flatMap((record) => {
    if (record.kind !== "follow_up" || record.details?.sourceSessionId !== sourceSessionId) return [];
    const items = record.details?.createdItems;
    return Array.isArray(items) ? (items as Array<{ taskId?: string; fingerprint?: string; boardRef?: string; url?: string }>) : [];
  });
}

type CreatedFollowUpItem = {
  taskId: string;
  fingerprint: string;
  boardRef: string;
  url?: string;
  title?: string;
  // Normalized board identity so session linking + dedupe work across providers (GitHub issue =
  // repo+issueNumber, GitHub draft = item id, Jira = id/key).
  provider: BoardProviderKey;
  itemId?: string;
  itemKey?: string;
  repo?: string;
  issueNumber?: number;
};

// Reconstruct a board identity from a stored boardRef string (used by re-run + backfill, where the
// normalized payload wasn't persisted). "owner/repo#5" → GitHub issue; "KT-3" → Jira key; else draft id.
function normalizeBoardRef(boardRef: string, provider: BoardProviderKey): {
  provider: BoardProviderKey;
  itemId?: string;
  itemKey?: string;
  repo?: string;
  issueNumber?: number;
} {
  if (provider === "jira") return { provider: "jira", itemKey: boardRef };
  const match = /^(.+)#(\d+)$/.exec(boardRef);
  if (match) return { provider: "github_project", repo: match[1], issueNumber: Number(match[2]), itemKey: boardRef };
  return { provider: "github_project", itemId: boardRef };
}

// Shared record-only creator. INVARIANT (tasks/workflow/task-list-redesign.md): writes a session DB
// row + aligns its board phase, NOTHING else — never starts/activates an agent. Returns the new id, or
// null if a session for this item already exists (dedupe by fingerprint, then by board identity).
function recordNotStartedSession(
  workspace: TandemConfig["workspaces"][number],
  params: {
    title: string;
    ideaType?: ProposedTask["type"];
    summary?: string;
    provider: BoardProviderKey;
    itemId?: string;
    itemKey?: string;
    repo?: string;
    issueNumber?: number;
    url?: string;
    spawnedFromSessionId?: string;
    spawnedFromTaskId?: string;
    spawnedFingerprint?: string;
    spawnedFromBoardRef?: string;
    spawnedOrder?: number;
  }
): string | null {
  if (params.spawnedFingerprint && db.findSessionIdBySpawnedFingerprint(params.spawnedFingerprint)) return null;
  if (
    db.findSessionIdByBoardIdentity({
      repo: params.repo,
      issueNumber: params.issueNumber,
      boardItemId: params.itemId,
      boardItemKey: params.itemKey
    })
  ) {
    return null;
  }
  const detail = db.createSession({
    title: params.title,
    artifactType: "issue",
    ideaType: params.ideaType,
    workspaceName: workspace.name,
    repo: params.repo,
    issueNumber: params.issueNumber,
    boardProvider: params.provider,
    boardItemId: params.itemId,
    boardItemKey: params.itemKey,
    boardItemUrl: params.url,
    issueBody: params.summary,
    spawnedFromSessionId: params.spawnedFromSessionId,
    spawnedFromTaskId: params.spawnedFromTaskId,
    spawnedFingerprint: params.spawnedFingerprint,
    spawnedFromBoardRef: params.spawnedFromBoardRef,
    spawnedOrder: params.spawnedOrder
  });
  db.updateBoardStatus(detail.session.id, boardStatusForSlot("inbox", workspace), workspace, "inbox");
  return detail.session.id;
}

async function createFollowUpBoardItem(
  workspace: TandemConfig["workspaces"][number],
  sourceSession: SessionDetail["session"],
  task: ProposedTask
): Promise<CreatedFollowUpItem> {
  const config = loadTandemConfig();
  const provider = boardProviderForWorkspace(config, workspace);
  const fingerprint = task.fingerprint || proposedTaskFingerprint(task.title, task.type);
  const body = followUpTaskBody(sourceSession, task);
  const title = task.title.trim();
  if (provider === "github_project") {
    if (!workspace.githubOwner || !workspace.projectNumber) {
      throw new Error("GitHub Project board is not configured for this workspace.");
    }
    const inboxStatus = boardStatusForSlot("inbox", workspace);
    if (workspace.issueRepository?.trim()) {
      const repo = workspace.issueRepository.trim();
      const issue = await board.createArtifact(repo, title, body, labelsForIdeaType(task.type));
      const addedToProject = await board.addArtifactToProject(workspace.githubOwner, workspace.projectNumber, issue.url);
      let statusSet = false;
      if (addedToProject) {
        for (let attempt = 0; attempt < 6 && !statusSet; attempt++) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
          statusSet = await board.updateStatus(
            workspace.githubOwner!,
            workspace.projectNumber!,
            repo,
            issue.issueNumber,
            boardStatusCandidatesForSlot("inbox", workspace)
          );
        }
      }
      if (!statusSet) {
        db.addWorkflowEvent(sourceSession.id, "follow_up.github.project_status.warning", "app", "warned", undefined, inboxStatus, false);
      }
      return {
        taskId: task.id,
        fingerprint,
        boardRef: `${repo}#${issue.issueNumber}`,
        url: issue.url,
        title,
        provider: "github_project",
        repo,
        issueNumber: issue.issueNumber,
        itemKey: `${repo}#${issue.issueNumber}`
      };
    }
    const draft = await board.createDraftArtifact(workspace.githubOwner, workspace.projectNumber, title, body);
    let statusSet = false;
    for (let attempt = 0; attempt < 4 && !statusSet; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800));
      statusSet = await board.updateProjectItemStatus(
        workspace.githubOwner,
        workspace.projectNumber,
        draft.id,
        boardStatusCandidatesForSlot("inbox", workspace)
      );
    }
    if (!statusSet) {
      db.addWorkflowEvent(sourceSession.id, "follow_up.github.project_status.warning", "app", "warned", undefined, inboxStatus, false);
    }
    return { taskId: task.id, fingerprint, boardRef: draft.id, url: draft.url, title, provider: "github_project", itemId: draft.id };
  }
  if (provider === "jira") {
    if (!workspace.jiraProjectKey?.trim()) throw new Error("Jira project key is not configured for this workspace.");
    const jira = jiraServiceForWorkspace(workspace.name);
    const issue = await jira.createIssue({
      projectKey: workspace.jiraProjectKey,
      issueType: workspace.jiraIssueType || "Task",
      title,
      body,
      labels: [task.type]
    });
    return {
      taskId: task.id,
      fingerprint,
      boardRef: issue.key,
      url: issue.url,
      title,
      provider: "jira",
      itemId: issue.id,
      itemKey: issue.key
    };
  }
  throw new Error("No board is configured for this workspace.");
}

function createNotStartedSessionForFollowUp(
  workspace: TandemConfig["workspaces"][number],
  sourceSession: SessionDetail["session"],
  created: CreatedFollowUpItem,
  task: ProposedTask,
  order: number
): void {
  recordNotStartedSession(workspace, {
    title: task.title,
    ideaType: task.type,
    summary: task.summary,
    provider: created.provider,
    itemId: created.itemId,
    itemKey: created.itemKey ?? created.boardRef,
    repo: created.repo,
    issueNumber: created.issueNumber,
    url: created.url,
    spawnedFromSessionId: sourceSession.id,
    spawnedFromTaskId: created.taskId,
    spawnedFingerprint: created.fingerprint,
    spawnedFromBoardRef: boardArtifactRefForSession(sourceSession),
    spawnedOrder: order
  });
}

// Backfill: create NOT STARTED task records for follow-up board items created in a PRIOR run (before
// this feature existed, or in a re-run that only made the board item). Best-effort, record-only. Reads
// each source session's `follow_up` evidence and fills in any missing session, pulling titles from the
// board where the older evidence didn't store them. Returns how many records it created.
async function backfillSpawnedTaskSessions(): Promise<number> {
  let created = 0;
  try {
    const config = loadTandemConfig();
    const artifactCache = new Map<string, BoardArtifactOption[]>();
    for (const summary of db.listSessions()) {
      const items = createdFollowUpItems(summary.id);
      if (items.length === 0) continue;
      const workspace = activeWorkspace(config, summary.workspaceName);
      if (!workspace) continue;
      const provider = boardProviderForWorkspace(config, workspace);
      if (provider === "none") continue;
      let artifacts = artifactCache.get(workspace.name);
      if (!artifacts) {
        artifacts = await listWorkspaceBoardArtifacts(workspace.name).catch(() => [] as BoardArtifactOption[]);
        artifactCache.set(workspace.name, artifacts);
      }
      const sourceRef = boardArtifactRefForSession(summary);
      let order = 0;
      for (const item of items) {
        const fingerprint = item.fingerprint ?? "";
        if (!item.boardRef) {
          order += 1;
          continue;
        }
        const identity = normalizeBoardRef(item.boardRef, provider);
        const richer = item as CreatedFollowUpItem;
        const art = artifacts.find(
          (candidate) => candidate.key === item.boardRef || candidate.id === item.boardRef
        );
        const id = recordNotStartedSession(workspace, {
          title: richer.title ?? art?.title ?? item.boardRef,
          summary: art?.body,
          provider: identity.provider,
          itemId: identity.itemId,
          itemKey: identity.itemKey,
          repo: identity.repo,
          issueNumber: identity.issueNumber,
          url: item.url ?? art?.url,
          spawnedFromSessionId: summary.id,
          spawnedFromTaskId: item.taskId,
          spawnedFingerprint: fingerprint || undefined,
          spawnedFromBoardRef: sourceRef,
          spawnedOrder: order
        });
        if (id) created += 1;
        order += 1;
      }
    }
  } catch {
    /* best-effort — never block startup on backfill */
  }
  return created;
}

async function createFollowUpTasks(sourceSessionId: string, tasks: ProposedTask[]): Promise<ProposedTask[]> {
  const detail = db.getSession(sourceSessionId);
  if (!detail) throw new Error("Source session not found.");
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  if (!workspace) throw new Error("Workspace not found for source session.");
  const priorItems = createdFollowUpItems(sourceSessionId);
  const createdItems: CreatedFollowUpItem[] = [];
  const failedItems: Array<{ taskId: string; error: string }> = [];
  const nextTasks: ProposedTask[] = [];

  for (const [index, task] of tasks.entries()) {
    const fingerprint = task.fingerprint || proposedTaskFingerprint(task.title, task.type);
    if (task.status === "skipped") {
      nextTasks.push({ ...task, fingerprint, status: "skipped" });
      continue;
    }
    const prior = [...priorItems, ...createdItems].find((item) => item.taskId === task.id || item.fingerprint === fingerprint);
    if (prior?.boardRef) {
      // Board item already exists from a previous run — don't recreate it, but DO ensure a NOT STARTED
      // session exists (the old path created only the board item). Record-only; dedupe makes it safe.
      const identity = normalizeBoardRef(prior.boardRef, boardProviderForWorkspace(config, workspace));
      createNotStartedSessionForFollowUp(
        workspace,
        detail.session,
        { taskId: task.id, fingerprint, boardRef: prior.boardRef, url: prior.url, title: task.title, ...identity },
        { ...task, fingerprint },
        index
      );
      nextTasks.push({ ...task, fingerprint, status: "created", boardRef: prior.boardRef, url: prior.url, error: undefined });
      continue;
    }
    if (task.status !== "selected" && task.status !== "failed" && task.status !== "proposed") {
      nextTasks.push({ ...task, fingerprint });
      continue;
    }
    try {
      const created = await createFollowUpBoardItem(workspace, detail.session, { ...task, fingerprint });
      createdItems.push(created);
      // Mirror each created board item as a NOT STARTED Twindem task record (record-only — see invariant).
      createNotStartedSessionForFollowUp(workspace, detail.session, created, { ...task, fingerprint }, index);
      nextTasks.push({ ...task, fingerprint, status: "created", boardRef: created.boardRef, url: created.url, error: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedItems.push({ taskId: task.id, error: message });
      nextTasks.push({ ...task, fingerprint, status: "failed", error: message });
    }
  }

  if (createdItems.length > 0 || failedItems.length > 0) {
    db.recordWorkflowEvidence(
      sourceSessionId,
      "follow_up",
      "Follow-up tasks created",
      createdItems.length > 0
        ? `Created ${createdItems.length} follow-up task${createdItems.length === 1 ? "" : "s"} from the ADR.`
        : "No follow-up tasks were created; all selected rows failed.",
      {
        source: "app",
        details: {
          sourceSessionId,
          sourceBoardRef: boardArtifactRefForSession(detail.session),
          createdItems,
          ...(failedItems.length > 0 ? { failedItems } : {})
        }
      }
    );
  }
  return nextTasks;
}

async function createSessionFromGithubIssue(sourceSessionId: string, repo: string, issueNumber: number): Promise<SessionDetail> {
  const existing = db.findSessionByIssue(repo, issueNumber);
  const source = db.getSession(sourceSessionId);
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, source?.session.workspaceName);
  const leftPane = workspacePaneDefault(config, "L", workspace?.name);
  const rightPane = workspacePaneDefault(config, "R", workspace?.name);
  const issue = await board.getArtifact(repo, issueNumber, workspace?.githubOwner, workspace?.projectNumber);

  if (existing) {
    db.saveGithubCache(existing.session.id, issue, workspace);
    return db.getSession(existing.session.id)!;
  }

  const created = db.createSession({
    title: issue.title || `${repo}#${issueNumber}`,
    artifactType: "issue",
    ideaType: inferIdeaType({ title: issue.title, labels: issue.labels }),
    workspaceName: source?.session.workspaceName ?? workspace?.name,
    repo,
    issueNumber,
    issueBody: issue.body,
    leftRole: source?.session.leftRole ?? leftPane.role,
    leftProvider: source?.session.leftProvider ?? leftPane.provider,
    rightRole: source?.session.rightRole ?? rightPane.role,
    rightProvider: source?.session.rightProvider ?? rightPane.provider,
    roundTotal: source?.session.roundTotal
  });

  db.linkGithubIssue(created.session.id, issue, workspace);
  db.saveGithubCache(created.session.id, issue, workspace);
  db.addWorkflowEvent(
    sourceSessionId,
    "github.issue_detected_as_session",
    "app",
    "ok",
    source?.session.visiblePhase,
    issue.projectStatus,
    false
  );
  return db.getSession(created.session.id)!;
}

function replaceIdeaTypeLabels(currentLabels: string[], ideaType?: string | null): string[] {
  const typeLabels = new Set(IDEA_TYPES.map((type) => type.labelName.toLowerCase()));
  const kept = currentLabels.filter((label) => !typeLabels.has(label.toLowerCase()));
  return Array.from(new Set([...kept, ...labelsForIdeaType(ideaType)]));
}

async function syncNotStartedBoard(sessionId: string): Promise<SessionDetail> {
  const detail = requireBoardSession(sessionId);
  if ((detail.session.agentRunCount ?? 0) > 0) return detail;
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  const provider = boardProviderForWorkspace(config, workspace);
  const title = detail.session.title.trim();
  if (!title) throw new Error("Session title is required.");
  const body = detail.session.initialBody?.trim() ?? "";

  switch (provider) {
    case "jira": {
      const key = detail.session.boardItemKey ?? detail.session.boardItemId;
      if (!key) throw new Error("This session has no Jira issue attached.");
      const jira = jiraServiceForWorkspace(workspace?.name);
      const current = await jira.getIssue(key);
      await jira.updateIssue(key, {
        title,
        body,
        labels: replaceIdeaTypeLabels(current.labels ?? [], detail.session.ideaType)
      });
      db.setSessionBody(sessionId, body);
      break;
    }
    case "github_project": {
      if (!detail.session.repo || !detail.session.issueNumber) throw new Error("This session has no GitHub issue attached.");
      const current = await board.getArtifact(
        detail.session.repo,
        detail.session.issueNumber,
        workspace?.githubOwner,
        workspace?.projectNumber
      );
      const wantedLabels = replaceIdeaTypeLabels(current.labels ?? [], detail.session.ideaType);
      const currentSet = new Set((current.labels ?? []).map((label) => label.toLowerCase()));
      const wantedSet = new Set(wantedLabels.map((label) => label.toLowerCase()));
      const typeLabels = new Set(IDEA_TYPES.map((type) => type.labelName.toLowerCase()));
      const addLabels = wantedLabels.filter((label) => !currentSet.has(label.toLowerCase()));
      const removeLabels = (current.labels ?? []).filter(
        (label) => typeLabels.has(label.toLowerCase()) && !wantedSet.has(label.toLowerCase())
      );
      const updated = await board.updateArtifact(detail.session.repo, detail.session.issueNumber, {
        title,
        body,
        addLabels,
        removeLabels
      });
      db.saveGithubCache(sessionId, updated, workspace);
      break;
    }
    case "none":
      return detail;
    default:
      throw new Error(`Board provider "${provider}" does not support syncing task edits yet.`);
  }

  db.addWorkflowEvent(sessionId, "board.not_started_synced", "app", "ok", detail.session.visiblePhase, undefined, true);
  return db.getSession(sessionId)!;
}

async function updateBoardArtifactBody(sessionId: string, body: string): Promise<SessionDetail> {
  const nextBody = body.trim();
  if (!nextBody) throw new Error("Issue body cannot be empty.");
  const detail = requireBoardSession(sessionId);
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  const provider = boardProviderForWorkspace(config, workspace);
  // Provider-neutral, mirroring commentBoardArtifact: the body update must work on the board the
  // session actually lives on. The Jira branch was missing, so Agent 1's corrected plan never
  // reached the Jira issue and the reviewer kept reading the stale one-line theme.
  switch (provider) {
    case "jira": {
      const key = detail.session.boardItemKey ?? detail.session.boardItemId;
      if (!key) throw new Error("This session has no Jira issue attached.");
      await jiraServiceForWorkspace(workspace?.name).updateDescription(key, nextBody);
      // Jira issue bodies aren't cached locally (getBoardArtifact returns body: "" for Jira), so the
      // reviewer brief falls back to initial_body. Mirror the pushed plan there so A2 reads it.
      db.setSessionBody(sessionId, nextBody);
      break;
    }
    case "github_project": {
      if (!detail.session.repo || !detail.session.issueNumber) throw new Error("This session has no GitHub issue attached.");
      await board.updateArtifactBody(detail.session.repo, detail.session.issueNumber, nextBody);
      break;
    }
    default:
      throw new Error("This workspace's board doesn't support editing the task body.");
  }
  db.addWorkflowEvent(sessionId, "board.artifact_body.updated", "human", "ok", detail.session.visiblePhase, undefined, true);
  // Re-sync only reads from GitHub; for Jira the synced copy is refreshed on the next board read.
  if (detail.session.repo && detail.session.issueNumber) await syncBoardArtifact(sessionId);
  return db.getSession(sessionId)!;
}

async function commentBoardArtifact(sessionId: string, body: string): Promise<SessionDetail> {
  const nextBody = body.trim();
  if (!nextBody) throw new Error("Comment cannot be empty.");
  const detail = requireBoardSession(sessionId);
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  const provider = boardProviderForWorkspace(config, workspace);
  // Provider-neutral: route to the board the session actually lives on. (Linear: add a case here when
  // the integration lands.)
  switch (provider) {
    case "jira": {
      const key = detail.session.boardItemKey ?? detail.session.boardItemId;
      if (!key) throw new Error("This session has no Jira issue attached.");
      await jiraServiceForWorkspace(workspace?.name).addComment(key, nextBody);
      break;
    }
    case "github_project": {
      if (!detail.session.repo || !detail.session.issueNumber) throw new Error("This session has no GitHub issue attached.");
      await board.commentArtifact(detail.session.repo, detail.session.issueNumber, nextBody);
      break;
    }
    default:
      throw new Error("This workspace's board doesn't support comments.");
  }
  db.addWorkflowEvent(sessionId, "board.artifact_commented", "human", "ok", detail.session.visiblePhase, undefined, true);
  // Re-sync only makes sense for a GitHub issue session (it reads repo/issue from GitHub).
  if (detail.session.repo && detail.session.issueNumber) await syncBoardArtifact(sessionId);
  return db.getSession(sessionId)!;
}

// THE single place that moves a board item to a workflow slot, provider-aware. GitHub Project and
// Jira (and "none") all go through here, so every status transition behaves the same and no caller
// needs GitHub-specific code. Tries all status-name candidates for the slot (workflows name columns
// differently), updates the local cache on success, and returns warnings (never throws on a missing
// status — the caller still advances local phase state and surfaces the warning).
async function applyBoardSlotStatus(
  detail: SessionDetail,
  workspace: TandemConfig["workspaces"][number] | undefined,
  slot: BoardStatusSlot
): Promise<{ warnings: string[]; appliedStatus: string }> {
  const config = loadTandemConfig();
  const provider = boardProviderForWorkspace(config, workspace);
  const sessionId = detail.session.id;
  const primary = boardStatusForSlot(slot, workspace);
  const candidates = boardStatusCandidatesForSlot(slot, workspace);

  if (provider === "none") {
    // No external board — nothing to move; the caller still advances local phase state.
    return { warnings: [], appliedStatus: primary };
  }

  if (provider === "jira") {
    const issueKey = detail.session.boardItemKey ?? detail.session.boardItemId;
    if (!issueKey) return { warnings: ["This session has no Jira issue attached."], appliedStatus: primary };
    const jira = jiraServiceForWorkspace(workspace?.name);
    for (const candidate of candidates) {
      if (await jira.transitionIssue(issueKey, candidate)) {
        db.updateBoardStatus(sessionId, candidate, workspace, slot);
        return { warnings: [], appliedStatus: candidate };
      }
    }
    db.addWorkflowEvent(sessionId, "jira.status.warning", "app", "warned", undefined, undefined, false);
    const available = await jira.availableStatuses(issueKey).catch(() => [] as string[]);
    const hint = available.length
      ? ` This Jira issue's workflow offers: ${available.join(", ")}. Map one of these to the "${slot}" step in Settings → Board.`
      : "";
    return { warnings: [`${projectStatusWarning(primary)}${hint}`], appliedStatus: primary };
  }

  // github_project
  if (!workspace?.githubOwner || !workspace.projectNumber) {
    return { warnings: ["Project GitHub board is not configured."], appliedStatus: primary };
  }
  // board.updateStatus accepts the candidate list; retry a few times for Project eventual consistency.
  let updated = false;
  for (let attempt = 0; attempt < 4 && !updated; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800));
    updated =
      detail.session.repo && detail.session.issueNumber
        ? await board.updateStatus(workspace.githubOwner, workspace.projectNumber, detail.session.repo, detail.session.issueNumber, candidates)
        : detail.session.boardItemId
          ? await board.updateProjectItemStatus(workspace.githubOwner, workspace.projectNumber, detail.session.boardItemId, candidates)
          : false;
  }
  if (!updated) {
    db.addWorkflowEvent(sessionId, "github.project_status.warning", "app", "warned", undefined, undefined, false);
    return { warnings: [projectStatusWarning(primary)], appliedStatus: primary };
  }
  db.updateBoardStatus(sessionId, primary, workspace, slot);
  return { warnings: [], appliedStatus: primary };
}

async function updateProjectStatus(sessionId: string, status: string, slot?: BoardStatusSlot): Promise<WorkflowActionResult> {
  const targetStatus = status.trim();
  if (!targetStatus) throw new Error("Project status is required.");
  const detail = db.getSession(sessionId);
  if (!detail) throw new Error("Session not found.");
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  const provider = boardProviderForWorkspace(config, workspace);
  // Prefer the explicit slot from the caller — re-deriving it from the status name is ambiguous when
  // two slots map to the same Jira status (e.g. uat and in_progress both → "In Progress").
  const targetSlot = slot ?? slotForBoardStatus(targetStatus, workspace);
  const ideaType = ideaTypeDefinition(detail.session.ideaType);
  if (targetSlot === "uat" && ideaType.requiresImplementation) return transitionWorkflow(sessionId, "uat");
  if (provider === "none") throw new Error("No board is configured for this workspace.");
  if (!targetSlot) throw new Error(`Unknown board status "${targetStatus}".`);
  const { warnings } = await applyBoardSlotStatus(detail, workspace, targetSlot);
  if (warnings.length === 0 && detail.session.repo && detail.session.issueNumber) await syncBoardArtifact(sessionId);
  return { session: db.getSession(sessionId)!, warnings };
}

async function createSession(input: CreateSessionInput): Promise<SessionDetail> {
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, input.workspaceName);
  const leftPane = workspacePaneDefault(config, "L", workspace?.name);
  const rightPane = workspacePaneDefault(config, "R", workspace?.name);
  let boardArtifact: BoardArtifactOption | undefined;
  if (input.boardItemId && workspace) {
    boardArtifact = (await listWorkspaceBoardArtifacts(workspace.name).catch(() => [])).find((artifact) => artifact.id === input.boardItemId);
  }
  const boardIdeaType = boardArtifact
    ? inferIdeaType({ title: boardArtifact.title, labels: boardArtifact.labels })
    : undefined;
  const normalized: CreateSessionInput = {
    ...input,
    ideaType:
      boardIdeaType && boardIdeaType !== "feature"
        ? boardIdeaType
        : inferIdeaType({ explicit: input.ideaType, title: input.title, quickNoteKind: input.quickNoteKind }),
    workspaceName: input.workspaceName ?? workspace?.name ?? config.defaults.workspaceName,
    leftRole: input.leftRole ?? leftPane.role,
    leftProvider: input.leftProvider ?? leftPane.provider,
    rightRole: input.rightRole ?? rightPane.role,
    rightProvider: input.rightProvider ?? rightPane.provider,
    roundTotal: input.roundTotal ?? workflowForWorkspace(config, workspace)?.roundLimit ?? 3,
    automationLevel: input.automationLevel ?? "auto"
  };

  // Picked attachments land in the workspace and are listed in the brief: the agents inspect them
  // locally (no GitHub upload — the platform has no public issue-attachment API).
  const attachmentPaths = importSessionAttachments(workspace?.root, input.attachments ?? []);
  if (attachmentPaths.length > 0) {
    const section = [
      "",
      "### Attachments (local files in the project root — agents must inspect these)",
      ...attachmentPaths.map((path) => `- ${path}`)
    ].join("\n");
    normalized.issueBody = `${(normalized.issueBody ?? "").trim()}\n${section}`.trim();
  }

  let createdIssue: GitHubIssueContext | undefined;
  let projectAddOk = true;
  let projectStatusOk = true;

  if (normalized.createGithubIssue) {
    if (!normalized.repo) throw new Error("Repository is required to create a GitHub issue.");
    createdIssue = await board.createArtifact(
      normalized.repo,
      normalized.title,
      normalized.issueBody ?? defaultIssueBody(normalized.title)
    );
    normalized.artifactType = "issue";
    normalized.issueNumber = createdIssue.issueNumber;

    if (workspace?.githubOwner && workspace.projectNumber) {
      projectAddOk = await board.addArtifactToProject(workspace.githubOwner, workspace.projectNumber, createdIssue.url);
      projectStatusOk = await board.updateStatus(
        workspace.githubOwner,
        workspace.projectNumber,
        normalized.repo,
        createdIssue.issueNumber,
        boardStatusCandidatesForSlot("planning", workspace)
      );
    }
  }

  const detail = db.createSession(normalized);
  if (createdIssue) {
    db.saveGithubCache(detail.session.id, createdIssue, workspace);
    if (!projectAddOk) {
      db.addWorkflowEvent(detail.session.id, "github.project_add.warning", "app", "warned", undefined, undefined, false);
    }
    if (!projectStatusOk) {
      db.addWorkflowEvent(detail.session.id, "github.project_status.warning", "app", "warned", undefined, undefined, false);
    }
    return db.getSession(detail.session.id)!;
  }

  if (normalized.repo && normalized.issueNumber) {
    await syncBoardArtifact(detail.session.id);
    return db.getSession(detail.session.id)!;
  }

  return detail;
}

// Returns an optional human notice (e.g. "the Jira task was moved to Cancelled instead of deleted")
// so the renderer can show what actually happened to the remote task.
async function deleteSession(id: string, options?: { deleteBoardArtifact?: boolean }): Promise<string | undefined> {
  if (options?.deleteBoardArtifact) {
    const detail = db.getSession(id);
    if (detail) {
      const config = loadTandemConfig();
      const workspace = activeWorkspace(config, detail.session.workspaceName);
      const provider = detail.session.boardProvider ?? workspace?.boardProvider ?? (workspace?.jiraSiteUrl ? "jira" : "github_project");
      if (detail.session.repo && detail.session.issueNumber) {
      if (workspace?.githubOwner && workspace.projectNumber) {
        let removed = false;
        for (let attempt = 0; attempt < 3 && !removed; attempt++) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 700));
          removed = await board.removeArtifactFromProject(
            workspace.githubOwner,
            workspace.projectNumber,
            detail.session.repo,
            detail.session.issueNumber
          );
        }
        // Removal failure is non-fatal: the item may already be gone (a previous, partially
        // failed delete), and the issue gets closed below either way. Throwing here made retries
        // fail FOREVER once the item was actually removed but a later step had thrown.
        if (!removed) {
          db.addWorkflowEvent(id, "github.project_remove.warning", "app", "warned", undefined, undefined, false);
        }
      }
      try {
        await board.closeArtifact(
          detail.session.repo,
          detail.session.issueNumber,
          [
            "Closing because the linked Twindem session was deleted by the user.",
            "",
            "---",
            "Author: Twindem",
            "Role: Workflow"
          ].join("\n")
        );
      } catch (error) {
        // A retry after a partial failure may find the issue already closed — that's success.
        const message = error instanceof Error ? error.message : String(error);
        if (!/already closed/i.test(message)) throw error;
      }
      } else if (provider === "jira" && (detail.session.boardItemKey || detail.session.boardItemId)) {
        if (!workspace?.jiraSiteUrl?.trim() || !workspace.jiraEmail?.trim() || !workspace.jiraApiTokenSecretRef?.trim()) {
          throw new Error("Jira board is not fully configured. Cannot delete the remote Jira task.");
        }
        const apiToken = readAgentApiKeySecret(workspace.jiraApiTokenSecretRef);
        if (!apiToken) throw new Error("Jira API token is missing from safeStorage. Cannot delete the remote Jira task.");
        const jira = new JiraService({
          siteUrl: workspace.jiraSiteUrl,
          email: workspace.jiraEmail,
          apiToken
        });
        const jiraKey = detail.session.boardItemKey ?? detail.session.boardItemId!;
        // CONSISTENT WITH GITHUB: Twindem doesn't hard-delete the remote task — it CLOSES it by moving
        // the issue to a final status (Won't Do / Cancelled, falling back to Done). This needs only
        // transition rights (which the account has), is reversible, and never requires the heavy
        // "Delete issues" permission.
        const closedAs = await closeJiraIssueToFinal(jira, jiraKey, workspace);
        if (!closedAs) {
          const available = await jira.availableStatuses(jiraKey).catch(() => [] as string[]);
          const hint = available.length
            ? ` This issue's workflow offers: ${available.join(", ")}. Map one of these to the "Won't Do" step in Settings → Board.`
            : "";
          throw new Error(
            `Couldn't move the Jira task ${jiraKey} to a Cancelled/Done status.${hint} Uncheck "Also delete the remote board task" to remove just the local Twindem session.`
          );
        }
        db.deleteSession(id);
        return `Local session removed. ${jiraKey} was moved to "${closedAs}" on Jira (Twindem closes Jira tasks instead of deleting them).`;
      } else if (provider === "github_project" && detail.session.boardItemId && workspace?.githubOwner && workspace.projectNumber) {
        try {
          await board.removeProjectItem(workspace.githubOwner, workspace.projectNumber, detail.session.boardItemId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Couldn't remove the board item: ${message}. Uncheck "Also delete the remote board task" to remove just the local Twindem session.`,
            { cause: error }
          );
        }
      } else {
        throw new Error("This session has no supported remote board task to delete or close.");
      }
    }
  }
  db.deleteSession(id);
  return undefined;
}

async function requestTaskReview(sessionId: string, commentBody?: string): Promise<WorkflowActionResult> {
  const warnings: string[] = [];
  const detail = requireBoardSession(sessionId);
  const config = loadTandemConfig();
  assertEvidenceGate(sessionId, detail, "requestTaskReview", gateKeys(config, detail, "requestTaskReview"));
  const workflow = config.workflows.default;
  const labels = workflow.labels;
  const project = activeWorkspace(config, detail.session.workspaceName);
  const provider = boardProviderForWorkspace(config, project);
  if (detail.session.repo && detail.session.issueNumber) {
    await board.requestTaskReview(detail.session.repo, detail.session.issueNumber, labels.taskReviewRequested, commentBody);
  } else if (commentBody?.trim()) {
    await commentBoardArtifact(sessionId, commentBody);
  } else if (provider !== "github_project") {
    await commentBoardArtifact(sessionId, "Task review requested by Twindem.");
  }
  if (provider === "github_project" && project?.githubOwner && project.projectNumber && detail.session.repo && detail.session.issueNumber) {
    const targetStatus = boardStatusForSlot("planning", project);
    const updated = await board.updateStatus(
      project.githubOwner,
      project.projectNumber,
      detail.session.repo!,
      detail.session.issueNumber!,
      boardStatusCandidatesForSlot("planning", project)
    );
    if (!updated) {
      warnings.push(projectStatusWarning(targetStatus));
    }
  } else {
    warnings.push(...(await applyBoardSlotStatus(detail, project, "planning")).warnings);
  }
  db.markTaskReviewRequested(sessionId);
  if (warnings.length > 0) {
    db.addWorkflowEvent(sessionId, "board.status.warning", "app", "warned", undefined, undefined, false);
  }
  if (detail.session.repo && detail.session.issueNumber) await syncBoardArtifact(sessionId);
  return { session: db.getSession(sessionId)!, warnings };
}

async function applyTaskReviewVerdict(
  sessionId: string,
  verdict: TaskReviewVerdict,
  commentBody?: string
): Promise<WorkflowActionResult> {
  if (verdict === "requested") return requestTaskReview(sessionId, commentBody);

  const warnings: string[] = [];
  const detail = requireBoardSession(sessionId);
  const config = loadTandemConfig();
  const workflow = config.workflows.default;
  const project = activeWorkspace(config, detail.session.workspaceName);
  const provider = boardProviderForWorkspace(config, project);

  if (verdict === "ok") {
    assertEvidenceGate(sessionId, detail, "reviewOk", gateKeys(config, detail, "reviewOk"));
  }

  if (detail.session.repo && detail.session.issueNumber) {
    await board.applyTaskReviewVerdict(detail.session.repo, detail.session.issueNumber, verdict, {
      requested: workflow.labels.taskReviewRequested,
      ok: workflow.labels.taskReviewOk,
      changes: workflow.labels.taskReviewChanges
    }, commentBody);
  } else if (commentBody?.trim()) {
    await commentBoardArtifact(sessionId, commentBody);
  } else if (provider !== "github_project") {
    await commentBoardArtifact(sessionId, `Task review verdict: ${verdict}.`);
  }

  const maxRoundsReached = verdict === "changes" && detail.session.roundN >= detail.session.roundTotal;
  const targetSlot: BoardStatusSlot = verdict === "ok" ? "ready" : verdict === "blocked" || maxRoundsReached ? "blocked" : "planning";
  const targetStatus = boardStatusForSlot(targetSlot, project);
  if (provider === "github_project" && project?.githubOwner && project.projectNumber && detail.session.repo && detail.session.issueNumber) {
    const updated = await board.updateStatus(
      project.githubOwner,
      project.projectNumber,
      detail.session.repo!,
      detail.session.issueNumber!,
      boardStatusCandidatesForSlot(targetSlot, project)
    );
    if (!updated) {
      warnings.push(projectStatusWarning(targetStatus));
    }
  } else {
    warnings.push(...(await applyBoardSlotStatus(detail, project, targetSlot)).warnings);
  }
  const localVerdict = verdict === "ok" ? "ok" : verdict === "blocked" ? "blocked" : "changes";
  db.recordTaskReview(sessionId, localVerdict);
  if (warnings.length > 0) {
    db.addWorkflowEvent(sessionId, "board.status.warning", "app", "warned", undefined, undefined, false);
  }
  if (detail.session.repo && detail.session.issueNumber) await syncBoardArtifact(sessionId);
  return { session: db.getSession(sessionId)!, warnings };
}

async function transitionWorkflow(
  sessionId: string,
  target: WorkflowTransitionTarget
): Promise<WorkflowActionResult> {
  const detail = requireBoardSession(sessionId);
  const config = loadTandemConfig();
  const project = activeWorkspace(config, detail.session.workspaceName);
  const ideaType = ideaTypeDefinition(detail.session.ideaType);
  // Deploy evidence gates (smoke tests, final verification…) only apply to deployable feature
  // delivery. A bug's Done means "confirmed fixed" (regression verification), not "production
  // release completed", so the release gate must not block closing a bug.
  const requiredGateKeys =
    ideaType.requiresImplementation &&
    isDeployableWorkspace(config, project) &&
    !(target === "done" && ideaType.key === "bug")
      ? gateKeys(config, detail, target)
      : [];
  assertEvidenceGate(sessionId, detail, target, requiredGateKeys);

  const targetSlot: BoardStatusSlot = target === "uat" ? "uat" : "done";
  const projectStatus = boardStatusForSlot(targetSlot, project);
  const internalState = sessionStateForSlot(targetSlot).internalState;
  // Provider-aware status move (GitHub / Jira / none) — same path as updateProjectStatus.
  const { warnings } = await applyBoardSlotStatus(detail, project, targetSlot);
  db.transitionSession(sessionId, target, internalState, projectStatus);
  // Re-sync only makes sense for a GitHub issue session (it reads repo/issue from GitHub).
  if (detail.session.repo && detail.session.issueNumber) await syncBoardArtifact(sessionId);
  return { session: db.getSession(sessionId)!, warnings };
}

async function deployUat(sessionId: string): Promise<WorkflowActionResult> {
  // The UAT deploy runs a LOCAL command; it doesn't need a GitHub issue — a Jira-backed task is fine.
  const detail = requireBoardSession(sessionId);
  const config = loadTandemConfig();
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  const command = workspace?.uatDeployCommand?.trim();
  const args = workspace?.uatDeployArgs ?? [];
  if (!workspace?.root || !existsSync(workspace.root)) {
    throw new Error("UAT deploy runner needs a valid workspace directory.");
  }
  if (!command) {
    throw new Error("No UAT deploy command is configured for this workspace.");
  }

  const attempt = db.startDeployAttempt(sessionId, command, args);
  db.addWorkflowEvent(sessionId, "uat.deploy.started", "app", "ok", detail.session.visiblePhase, undefined, true);
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: workspace.root,
      env: { ...process.env, PATH: expandedPath() },
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 8
    });
    const ref = deployEvidenceRef(command, args, stdout, stderr);
    db.finishDeployAttempt(attempt.id, "succeeded", deployCommandOutput(stdout, stderr));
    db.updateEvidence(sessionId, "deploy_evidence", "done", "app", ref);
    db.addWorkflowEvent(sessionId, "uat.deploy.completed", "app", "ok", detail.session.visiblePhase, undefined, true);
    return { session: db.getSession(sessionId)!, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.finishDeployAttempt(attempt.id, "failed", undefined, message);
    db.updateEvidence(sessionId, "deploy_evidence", "blocked", "app", message);
    db.addWorkflowEvent(sessionId, "uat.deploy.failed", "app", "blocked", detail.session.visiblePhase, undefined, true);
    throw new Error(`UAT deploy command failed: ${message}`, { cause: error });
  }
}

function deployCommandOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n--- stderr ---\n");
}

function deployEvidenceRef(command: string, args: string[], stdout: string, stderr: string): string {
  const output = deployCommandOutput(stdout, stderr);
  const trimmed = output.length > 3000 ? `${output.slice(0, 3000)}...` : output;
  return [`Command: ${[command, ...args].join(" ")}`, trimmed ? `Output:\n${trimmed}` : "Output: command completed without output"].join("\n");
}

function projectStatusWarning(statusName: string): string {
  return `Project status was not updated to "${statusName}" because the Project item, Status field, or Status option was not found.`;
}

function activeWorkspace(config: TandemConfig, workspaceName?: string): TandemConfig["workspaces"][number] | undefined {
  return (
    config.workspaces.find((workspace) => workspace.name === (workspaceName ?? config.defaults.workspaceName)) ??
    config.workspaces[0]
  );
}

function isPathInside(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function workspacePaneDefault(config: TandemConfig, side: AgentSide, workspaceName?: string): TandemConfig["defaults"]["leftPane"] {
  const workspace = activeWorkspace(config, workspaceName);
  const fallback = side === "L" ? config.defaults.leftPane : config.defaults.rightPane;
  return (side === "L" ? workspace?.leftPane : workspace?.rightPane) ?? fallback;
}

function workflowForWorkspace(
  config: TandemConfig,
  workspace?: TandemConfig["workspaces"][number]
): TandemConfig["workflows"][string] | undefined {
  return config.workflows[workspace?.workflowTemplate ?? ""] ?? config.workflows.default;
}

function instructionTemplate(config: TandemConfig, workspaceName: string | undefined, key: string, fallback: string): string {
  const workflow = workflowForWorkspace(config, activeWorkspace(config, workspaceName));
  return workflow?.instructionTemplates?.[key]?.trim() || fallback;
}

function renderInstructionTemplate(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function assertEvidenceGate(sessionId: string, detail: SessionDetail, action: string, requiredKeys: string[]): void {
  const missing = requiredKeys.filter((key) => detail.evidence.find((item) => item.key === key)?.status !== "done");
  if (missing.length === 0) return;
  db.addWorkflowEvent(sessionId, `gate.${action}.blocked`, "app", "blocked", detail.session.visiblePhase, undefined, false);
  throw new Error(`Blocked by evidence gate: ${missing.join(", ")} must be marked Done first.`);
}

function gateKeys(config: TandemConfig, detail: SessionDetail, action: string): string[] {
  const workflow = workflowForWorkspace(config, activeWorkspace(config, detail.session.workspaceName));
  return workflow?.gates?.[action] ?? [];
}

function defaultIssueBody(title: string): string {
  return `# ${title}

## Context
Created from Twindem.

## Acceptance Criteria
- [ ] Define the expected outcome.

## Test Plan
- [ ] Add verification steps before implementation.

---
Author: Twindem
Role: Workflow`;
}

function sessionMarkdown(detail: SessionDetail): string {
  const session = detail.session;
  const boardRef = session.repo && session.issueNumber
    ? `${session.repo}#${session.issueNumber}`
    : session.boardItemKey ?? session.boardItemId ?? "Not attached";
  const lines = [
    `# ${session.title}`,
    "",
    "## Artifact",
    "",
    `- Type: ${session.artifactType}`,
    `- Workspace: ${session.workspaceName ?? "Not set"}`,
    `- Board ref: ${boardRef}`,
    `- Phase: ${session.visiblePhase}`,
    `- Internal state: ${session.internalState}`,
    `- Status: ${session.status}`,
    `- Updated: ${session.updatedAt}`,
    "",
    "## Initial Prompt",
    "",
    session.initialBody?.trim() || "_No initial prompt recorded._",
    "",
    "## Agents",
    "",
    `- Agent 1: ${session.leftRole ?? "Not set"} (${session.leftProvider ?? "Not set"})`,
    `- Agent 2: ${session.rightRole ?? "Not set"} (${session.rightProvider ?? "Not set"})`,
    "",
    "## Evidence",
    "",
    ...detail.evidence.map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.title} (${item.status})${item.ref ? ` - ${item.ref}` : ""}`),
    "",
    "## Native Output Cards",
    "",
    ...(detail.outputCards.length
      ? detail.outputCards.map((card) => [`### ${card.title}`, "", `- Agent: ${card.side}`, `- Kind: ${card.kind}`, `- Time: ${card.createdAt}`, "", card.body].join("\n"))
      : ["_No native output cards recorded._"]),
    "",
    "## Workflow Events",
    "",
    ...(detail.workflowEvents.length
      ? detail.workflowEvents.map((event) => `- ${event.createdAt}: ${event.action} -> ${event.result}`)
      : ["_No workflow events recorded._"]),
    "",
    "## Board",
    "",
    detail.board
      ? [
          `- Provider: ${detail.board.provider}`,
          `- URL: ${detail.board.url ?? session.boardItemUrl ?? ""}`,
          `- Status: ${detail.board.status ?? session.boardStatus ?? session.visiblePhase}`,
          `- Labels: ${detail.board.labels.join(", ") || "None"}`
        ].join("\n")
      : detail.github
        ? [`- Provider: github_project`, `- URL: ${detail.github.url}`, `- Status: ${detail.github.projectStatus ?? detail.github.state}`, `- Labels: ${detail.github.labels.join(", ") || "None"}`].join("\n")
        : "_No board artifact cached._",
    ""
  ];
  return lines.join("\n");
}

function safeFilename(value: string): string {
  const normalized = value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return normalized || "twindem-session";
}

function requireIssueSession(sessionId: string): SessionDetail {
  const detail = db.getSession(sessionId);
  if (!detail) throw new Error("Session not found");
  if (!detail.session.repo || !detail.session.issueNumber) {
    throw new Error("This action requires a GitHub issue session with repo and issue number.");
  }
  return detail;
}

// Provider-neutral: accepts a GitHub issue session OR a Jira / board-item session. Used by the
// workflow transitions (Refinement/UAT/Done/deploy) so they work on any board, not just GitHub.
function requireBoardSession(sessionId: string): SessionDetail {
  const detail = db.getSession(sessionId);
  if (!detail) throw new Error("Session not found");
  const hasGithub = Boolean(detail.session.repo && detail.session.issueNumber);
  const hasBoardItem = Boolean(detail.session.boardItemKey || detail.session.boardItemId);
  if (!hasGithub && !hasBoardItem) {
    throw new Error("This action requires a board task (a GitHub issue or a Jira issue).");
  }
  return detail;
}

app.whenReady().then(() => {
  app.setName("Twindem");
  setAttentionBadge(false);
  db = new TandemDatabase();
  agents = new AgentManager(
    () => mainWindow,
    ({ sessionId, side, data }) => {
      if (sessionId) bufferPtyTranscript(sessionId, side, data);
    },
    ({ id, sessionId, side, exitCode }) => {
      if (sessionId) {
        flushPtyTranscript(ptyBufferKey(sessionId, side));
        db.finishAgentRun(id, sessionId, side, exitCode);
        finalizeUsageRun(id);
      }
    }
  );
  github = new GitHubService();
  board = new GitHubBoardProvider(github);
  registerIpc();
  createWindow();
  createApplicationMenu();
  // Surface follow-up board items created before the Tasks-list feature (or in a board-only re-run) as
  // NOT STARTED tasks. Best-effort + record-only; tell the renderer to re-list when it adds any.
  void backfillSpawnedTaskSessions().then((count) => {
    if (count > 0) mainWindow?.webContents.send("app:tasksChanged");
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  flushAllPtyTranscripts();
  finalizeAllUsageRuns();
  db?.markRunningAgentRunsInterrupted();
  agents?.stopAll();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
