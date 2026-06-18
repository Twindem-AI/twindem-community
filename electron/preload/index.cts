import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentSide,
  AgentSignal,
  BoardArtifact,
  BoardArtifactOption,
  ComposerMessageInput,
  ConductorSnapshot,
  CreateSessionInput,
  EvidenceRecord,
  EvidenceRecordInput,
  EvidenceStatus,
  Handoff,
  GitHubAuthStatus,
  GitHubIssueContext,
  GitHubProjectOption,
  GitHubProjectOwnerOption,
  GitHubAccountRepo,
  GitHubRepoOption,
  GitRepoInspection,
  JiraProjectOption,
  JiraProjectStatuses,
  NativeOutputCard,
  NativeOutputCardInput,
  ProposedTask,
  SessionDetail,
  SessionSummary,
  TaskReviewVerdict,
  TranscriptEvent,
  UpdateSessionInput,
  UsageEvent,
  UsageSummary,
  WorkflowTransitionTarget,
  WorkflowActionResult
} from "../../shared/domain.js";
import type { BoardStatusSlot, TandemConfig } from "../../shared/config.js";
import type { ApiKeyValidationResult, CommandCheckResult, TandemApi, TandemResult } from "../../shared/api.js";

const tandemApi: TandemApi = {
  app: {
    onNewProject: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("app:newProject", listener);
      return () => ipcRenderer.removeListener("app:newProject", listener);
    },
    onOpenSettings: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("app:openSettings", listener);
      return () => ipcRenderer.removeListener("app:openSettings", listener);
    },
    onOpenProjects: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("app:projects", listener);
      return () => ipcRenderer.removeListener("app:projects", listener);
    },
    onTasksChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("app:tasksChanged", listener);
      return () => ipcRenderer.removeListener("app:tasksChanged", listener);
    },
    onAbout: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("app:about", listener);
      return () => ipcRenderer.removeListener("app:about", listener);
    },
    version: () => ipcRenderer.invoke("app:version") as Promise<TandemResult<string>>,
    setAttentionBadge: (active: boolean) =>
      ipcRenderer.invoke("app:setAttentionBadge", active) as Promise<TandemResult<void>>
  },
  config: {
    get: () => ipcRenderer.invoke("config:get") as Promise<TandemResult<TandemConfig>>,
    save: (config: TandemConfig) =>
      ipcRenderer.invoke("config:save", config) as Promise<TandemResult<TandemConfig>>,
    pickDirectory: () => ipcRenderer.invoke("config:pickDirectory") as Promise<TandemResult<string | null>>,
    validateDirectory: (path: string) =>
      ipcRenderer.invoke("config:validateDirectory", path) as Promise<TandemResult<{ ok: boolean; message: string }>>,
    pickFiles: (defaultPath?: string) => ipcRenderer.invoke("config:pickFiles", defaultPath) as Promise<TandemResult<string[] | null>>,
    pickWorkspaceSubdirectory: (root: string) =>
      ipcRenderer.invoke("config:pickWorkspaceSubdirectory", root) as Promise<TandemResult<{ absolutePath: string; relativePath: string } | null>>,
    importFile: () => ipcRenderer.invoke("config:importFile") as Promise<TandemResult<TandemConfig | null>>,
    exportFile: (config: TandemConfig) =>
      ipcRenderer.invoke("config:exportFile", config) as Promise<TandemResult<string | null>>,
    deleteProject: (workspaceName: string, options?: { deleteSourceFolder?: boolean; confirmationName?: string }) =>
      ipcRenderer.invoke("project:delete", workspaceName, options) as Promise<TandemResult<{ deletedSessions: number; project: string; sourceFolderDeleted?: boolean; sourceFolderDeleteError?: string }>>
  },
  secrets: {
    set: (ref: string, value: string) =>
      ipcRenderer.invoke("secrets:set", ref, value) as Promise<TandemResult<boolean>>,
    has: (ref: string) =>
      ipcRenderer.invoke("secrets:has", ref) as Promise<TandemResult<boolean>>,
    clear: (ref: string) =>
      ipcRenderer.invoke("secrets:clear", ref) as Promise<TandemResult<boolean>>,
    setAgentApiKey: (ref: string, value: string) =>
      ipcRenderer.invoke("secrets:setAgentApiKey", ref, value) as Promise<TandemResult<boolean>>,
    hasAgentApiKey: (ref: string) =>
      ipcRenderer.invoke("secrets:hasAgentApiKey", ref) as Promise<TandemResult<boolean>>,
    clearAgentApiKey: (ref: string) =>
      ipcRenderer.invoke("secrets:clearAgentApiKey", ref) as Promise<TandemResult<boolean>>,
    validateAgentApiKey: (envName: string, value: string) =>
      ipcRenderer.invoke("secrets:validateAgentApiKey", envName, value) as Promise<TandemResult<ApiKeyValidationResult>>
  },
  sessions: {
    list: () => ipcRenderer.invoke("sessions:list") as Promise<TandemResult<SessionSummary[]>>,
    get: (id: string) => ipcRenderer.invoke("sessions:get", id) as Promise<TandemResult<SessionDetail | null>>,
    create: (input: CreateSessionInput) => ipcRenderer.invoke("sessions:create", input) as Promise<TandemResult<SessionDetail>>,
    update: (input: UpdateSessionInput) => ipcRenderer.invoke("sessions:update", input) as Promise<TandemResult<SessionDetail>>,
    syncNotStartedBoard: (id: string) =>
      ipcRenderer.invoke("sessions:syncNotStartedBoard", id) as Promise<TandemResult<SessionDetail>>,
    delete: (id: string, options?: { deleteBoardArtifact?: boolean }) =>
      ipcRenderer.invoke("sessions:delete", id, options) as Promise<TandemResult<string | undefined>>,
    download: (id: string) => ipcRenderer.invoke("sessions:download", id) as Promise<TandemResult<string | null>>,
    setHidden: (id: string, hidden: boolean) =>
      ipcRenderer.invoke("sessions:setHidden", id, hidden) as Promise<TandemResult<void>>,
    getActive: () => ipcRenderer.invoke("sessions:getActive") as Promise<TandemResult<string | null>>,
    setActive: (id: string | null) => ipcRenderer.invoke("sessions:setActive", id) as Promise<TandemResult<void>>
  },
  composer: {
    send: (input: ComposerMessageInput) =>
      ipcRenderer.invoke("composer:send", input) as Promise<TandemResult<TranscriptEvent>>
  },
  cards: {
    add: (input: NativeOutputCardInput) =>
      ipcRenderer.invoke("cards:add", input) as Promise<TandemResult<NativeOutputCard>>
  },
  handoffs: {
    createDraft: (sessionId: string, fromSide: AgentSide, fromRole: string, toSide: AgentSide, toRole: string) =>
      ipcRenderer.invoke("handoffs:createDraft", sessionId, fromSide, fromRole, toSide, toRole) as Promise<
        TandemResult<Handoff>
      >,
    approve: (handoffId: string) => ipcRenderer.invoke("handoffs:approve", handoffId) as Promise<TandemResult<Handoff | null>>
  },
  evidence: {
    updateStatus: (sessionId: string, key: string, status: EvidenceStatus, ref?: string) =>
      ipcRenderer.invoke("evidence:updateStatus", sessionId, key, status, ref) as Promise<TandemResult<SessionDetail>>,
    addRecord: (input: EvidenceRecordInput) =>
      ipcRenderer.invoke("evidence:addRecord", input) as Promise<TandemResult<EvidenceRecord>>,
    listRecords: (sessionId: string) =>
      ipcRenderer.invoke("evidence:listRecords", sessionId) as Promise<TandemResult<EvidenceRecord[]>>
  },
  workflow: {
    recordTaskReview: (sessionId: string, verdict: "ok" | "changes" | "blocked") =>
      ipcRenderer.invoke("workflow:recordTaskReview", sessionId, verdict) as Promise<TandemResult<SessionDetail>>
    ,
    requestTaskReview: (sessionId: string, commentBody?: string) =>
      ipcRenderer.invoke("workflow:requestTaskReview", sessionId, commentBody) as Promise<
        TandemResult<WorkflowActionResult>
      >,
    applyTaskReviewVerdict: (sessionId: string, verdict: TaskReviewVerdict, commentBody?: string) =>
      ipcRenderer.invoke("workflow:applyTaskReviewVerdict", sessionId, verdict, commentBody) as Promise<
        TandemResult<WorkflowActionResult>
      >,
    deployUat: (sessionId: string) =>
      ipcRenderer.invoke("workflow:deployUat", sessionId) as Promise<TandemResult<WorkflowActionResult>>,
    transition: (sessionId: string, target: WorkflowTransitionTarget) =>
      ipcRenderer.invoke("workflow:transition", sessionId, target) as Promise<TandemResult<WorkflowActionResult>>,
    createFollowUpTasks: (sourceSessionId: string, tasks: ProposedTask[]) =>
      ipcRenderer.invoke("workflow:createFollowUpTasks", sourceSessionId, tasks) as Promise<TandemResult<ProposedTask[]>>
  },
  conductor: {
    update: (sessionId: string, patch: Partial<Omit<ConductorSnapshot, "sessionId" | "updatedAt">>) =>
      ipcRenderer.invoke("conductor:update", sessionId, patch) as Promise<TandemResult<SessionDetail>>
  },
  github: {
    syncIssue: (sessionId: string) =>
      ipcRenderer.invoke("github:syncIssue", sessionId) as Promise<TandemResult<GitHubIssueContext>>,
    attachIssue: (sessionId: string, repo: string, issueNumber: number) =>
      ipcRenderer.invoke("github:attachIssue", sessionId, repo, issueNumber) as Promise<TandemResult<SessionDetail>>,
    updateProjectStatus: (sessionId: string, status: string) =>
      ipcRenderer.invoke("github:updateProjectStatus", sessionId, status) as Promise<TandemResult<WorkflowActionResult>>,
    authStatus: () => ipcRenderer.invoke("github:authStatus") as Promise<TandemResult<GitHubAuthStatus>>,
    login: () => ipcRenderer.invoke("github:login") as Promise<TandemResult<GitHubAuthStatus>>,
    listProjects: () => ipcRenderer.invoke("github:listProjects") as Promise<TandemResult<GitHubProjectOption[]>>,
    listProjectOwners: () =>
      ipcRenderer.invoke("github:listProjectOwners") as Promise<TandemResult<GitHubProjectOwnerOption[]>>,
    createProject: (owner: string, title: string) =>
      ipcRenderer.invoke("github:createProject", owner, title) as Promise<TandemResult<GitHubProjectOption>>,
    listWorkspaceRepos: (workspaceRoot: string) =>
      ipcRenderer.invoke("github:listWorkspaceRepos", workspaceRoot) as Promise<TandemResult<GitHubRepoOption[]>>,
    listRepos: (owner: string, limit?: number) =>
      ipcRenderer.invoke("github:listRepos", owner, limit) as Promise<TandemResult<GitHubAccountRepo[]>>,
    createRepo: (owner: string, name: string, isPrivate: boolean) =>
      ipcRenderer.invoke("github:createRepo", owner, name, isPrivate) as Promise<TandemResult<GitHubAccountRepo>>,
    inspectGitRepo: (path: string) =>
      ipcRenderer.invoke("github:inspectGitRepo", path) as Promise<TandemResult<GitRepoInspection>>,
    linkRemote: (path: string, owner: string, name: string) =>
      ipcRenderer.invoke("github:linkRemote", path, owner, name) as Promise<TandemResult<void>>,
    gitStatusShort: (path: string) =>
      ipcRenderer.invoke("github:gitStatusShort", path) as Promise<TandemResult<string>>,
    initialPush: (path: string, message?: string) =>
      ipcRenderer.invoke("github:initialPush", path, message) as Promise<TandemResult<void>>
  },
  board: {
    syncArtifact: (sessionId: string) =>
      ipcRenderer.invoke("board:syncArtifact", sessionId) as Promise<TandemResult<GitHubIssueContext>>,
    getArtifact: (sessionId: string) =>
      ipcRenderer.invoke("board:getArtifact", sessionId) as Promise<TandemResult<BoardArtifact | null>>,
    attachArtifact: (sessionId: string, repo: string, issueNumber: number) =>
      ipcRenderer.invoke("board:attachArtifact", sessionId, repo, issueNumber) as Promise<TandemResult<SessionDetail>>,
    createSessionFromArtifact: (sourceSessionId: string, repo: string, issueNumber: number) =>
      ipcRenderer.invoke(
        "board:createSessionFromArtifact",
        sourceSessionId,
        repo,
        issueNumber
      ) as Promise<TandemResult<SessionDetail>>,
    createTask: (sessionId: string, input: { title?: string; body?: string; repo?: string; labels?: string[] }) =>
      ipcRenderer.invoke("board:createTask", sessionId, input) as Promise<TandemResult<SessionDetail>>,
    updateArtifactBody: (sessionId: string, body: string) =>
      ipcRenderer.invoke("board:updateArtifactBody", sessionId, body) as Promise<TandemResult<SessionDetail>>,
    commentArtifact: (sessionId: string, body: string) =>
      ipcRenderer.invoke("board:commentArtifact", sessionId, body) as Promise<TandemResult<SessionDetail>>,
    updateStatus: (sessionId: string, status: string, slot?: BoardStatusSlot) =>
      ipcRenderer.invoke("board:updateStatus", sessionId, status, slot) as Promise<TandemResult<WorkflowActionResult>>,
    authStatus: () => ipcRenderer.invoke("board:authStatus") as Promise<TandemResult<GitHubAuthStatus>>,
    connect: () => ipcRenderer.invoke("board:connect") as Promise<TandemResult<GitHubAuthStatus>>,
    listProjects: () => ipcRenderer.invoke("board:listProjects") as Promise<TandemResult<GitHubProjectOption[]>>,
    listProjectOwners: () =>
      ipcRenderer.invoke("board:listProjectOwners") as Promise<TandemResult<GitHubProjectOwnerOption[]>>,
    createProject: (owner: string, title: string) =>
      ipcRenderer.invoke("board:createProject", owner, title) as Promise<TandemResult<GitHubProjectOption>>,
    listWorkspaceRepos: (workspaceRoot: string) =>
      ipcRenderer.invoke("board:listWorkspaceRepos", workspaceRoot) as Promise<TandemResult<GitHubRepoOption[]>>,
    listArtifacts: (owner: string, projectNumber: number) =>
      ipcRenderer.invoke("board:listArtifacts", owner, projectNumber) as Promise<TandemResult<BoardArtifactOption[]>>,
    listWorkspaceArtifacts: (workspaceName?: string) =>
      ipcRenderer.invoke("board:listWorkspaceArtifacts", workspaceName) as Promise<TandemResult<BoardArtifactOption[]>>,
    validateJira: (input: { siteUrl: string; email: string; apiToken: string }) =>
      ipcRenderer.invoke("board:validateJira", input) as Promise<TandemResult<GitHubAuthStatus>>
  },
  usage: {
    list: (sessionId: string) => ipcRenderer.invoke("usage:list", sessionId) as Promise<TandemResult<UsageEvent[]>>,
    summary: (sessionId: string) =>
      ipcRenderer.invoke("usage:summary", sessionId) as Promise<TandemResult<UsageSummary | undefined>>,
    workspaceSummary: (workspaceName: string) =>
      ipcRenderer.invoke("usage:workspaceSummary", workspaceName) as Promise<TandemResult<UsageSummary | undefined>>
  },
  jira: {
    listProjects: (creds: { siteUrl: string; email: string; apiToken: string }) =>
      ipcRenderer.invoke("jira:listProjects", creds) as Promise<TandemResult<JiraProjectOption[]>>,
    createProject: (creds: { siteUrl: string; email: string; apiToken: string }, input: { key: string; name: string }) =>
      ipcRenderer.invoke("jira:createProject", creds, input) as Promise<TandemResult<JiraProjectOption>>,
    listProjectsForWorkspace: (workspaceName?: string) =>
      ipcRenderer.invoke("jira:listProjectsForWorkspace", workspaceName) as Promise<TandemResult<JiraProjectOption[]>>,
    createProjectForWorkspace: (workspaceName: string, input: { key: string; name: string }) =>
      ipcRenderer.invoke("jira:createProjectForWorkspace", workspaceName, input) as Promise<TandemResult<JiraProjectOption>>,
    listProjectStatuses: (creds: { siteUrl: string; email: string; apiToken: string }, projectKey: string, issueType?: string) =>
      ipcRenderer.invoke("jira:listProjectStatuses", creds, projectKey, issueType) as Promise<TandemResult<JiraProjectStatuses>>,
    listProjectStatusesForWorkspace: (workspaceName: string, projectKey: string, issueType?: string) =>
      ipcRenderer.invoke("jira:listProjectStatusesForWorkspace", workspaceName, projectKey, issueType) as Promise<TandemResult<JiraProjectStatuses>>
  },
  system: {
    checkCommand: (command: string) =>
      ipcRenderer.invoke("system:checkCommand", command) as Promise<TandemResult<CommandCheckResult>>
  },
  signals: {
    poll: (sessionId: string) => ipcRenderer.invoke("signals:poll", sessionId) as Promise<TandemResult<AgentSignal[]>>,
    clear: (sessionId: string, side?: AgentSide) =>
      ipcRenderer.invoke("signals:clear", sessionId, side) as Promise<TandemResult<void>>,
    readIdeaBody: (sessionId: string, consume?: boolean) =>
      ipcRenderer.invoke("signals:readIdeaBody", sessionId, consume) as Promise<TandemResult<string | null>>
  },
  agents: {
    start: (
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
      ipcRenderer.invoke(
        "agents:start",
        side,
        command,
        args,
        cwd,
        sessionId,
        role,
        provider,
        nativeSessionId,
        nativeSessionName,
        resumeCommand,
        resumeArgs
      ) as Promise<TandemResult<string>>,
    isRunning: (side: AgentSide) =>
      ipcRenderer.invoke("agents:isRunning", side) as Promise<TandemResult<boolean>>,
    runningSession: (side: AgentSide) =>
      ipcRenderer.invoke("agents:runningSession", side) as Promise<TandemResult<string | undefined>>,
    write: (side: AgentSide, data: string) => ipcRenderer.invoke("agents:write", side, data) as Promise<TandemResult<void>>,
    resize: (side: AgentSide, cols: number, rows: number) =>
      ipcRenderer.invoke("agents:resize", side, cols, rows) as Promise<TandemResult<void>>,
    stop: (side: AgentSide) => ipcRenderer.invoke("agents:stop", side) as Promise<TandemResult<void>>,
    clearResume: (sessionId: string, side: AgentSide) =>
      ipcRenderer.invoke("agents:clearResume", sessionId, side) as Promise<TandemResult<SessionDetail>>,
    restart: (
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
      ipcRenderer.invoke(
        "agents:restart",
        side,
        command,
        args,
        cwd,
        sessionId,
        role,
        provider,
        nativeSessionId,
        nativeSessionName,
        resumeCommand,
        resumeArgs
      ) as Promise<TandemResult<string>>,
    onData: (callback: (payload: { side: AgentSide; data: string; sessionId?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { side: AgentSide; data: string; sessionId?: string }) =>
        callback(payload);
      ipcRenderer.on("agent:data", listener);
      return () => ipcRenderer.removeListener("agent:data", listener);
    },
    onExit: (callback: (payload: { side: AgentSide; exitCode: number; sessionId?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { side: AgentSide; exitCode: number; sessionId?: string }) =>
        callback(payload);
      ipcRenderer.on("agent:exit", listener);
      return () => ipcRenderer.removeListener("agent:exit", listener);
    }
  }
};

contextBridge.exposeInMainWorld("tandem", tandemApi);
contextBridge.exposeInMainWorld("twindem", tandemApi);
