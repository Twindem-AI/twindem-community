import type { BoardStatusSlot, TandemConfig } from "./config.js";
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
  GitHubAccountRepo,
  GitHubAuthStatus,
  GitHubIssueContext,
  GitRepoInspection,
  GitHubProjectOption,
  GitHubProjectOwnerOption,
  GitHubRepoOption,
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
} from "./domain.js";

export type TandemResult<T> = { ok: true; data: T } | { ok: false; error: { message: string } };
export type CommandCheckResult = { ok: boolean; command: string; path?: string; message: string };
export type ApiKeyValidationResult = { ok: boolean; provider: string; message: string };

export type TandemApi = {
  app: {
    onNewProject: (callback: () => void) => () => void;
    onOpenSettings: (callback: () => void) => () => void;
    onOpenProjects: (callback: () => void) => () => void;
    onTasksChanged: (callback: () => void) => () => void;
    onAbout: (callback: () => void) => () => void;
    version: () => Promise<TandemResult<string>>;
    setAttentionBadge: (active: boolean) => Promise<TandemResult<void>>;
  };
  config: {
    get: () => Promise<TandemResult<TandemConfig>>;
    save: (config: TandemConfig) => Promise<TandemResult<TandemConfig>>;
    pickDirectory: () => Promise<TandemResult<string | null>>;
    validateDirectory: (path: string) => Promise<TandemResult<{ ok: boolean; message: string }>>;
    pickFiles: (defaultPath?: string) => Promise<TandemResult<string[] | null>>;
    pickWorkspaceSubdirectory: (root: string) => Promise<TandemResult<{ absolutePath: string; relativePath: string } | null>>;
    importFile: () => Promise<TandemResult<TandemConfig | null>>;
    exportFile: (config: TandemConfig) => Promise<TandemResult<string | null>>;
    // Delete all LOCAL data for a project (sessions + DB + .twindem cache + token + config entry).
    // Never touches the code folder or the remote board.
    deleteProject: (
      workspaceName: string,
      options?: { deleteSourceFolder?: boolean; confirmationName?: string }
    ) => Promise<TandemResult<{ deletedSessions: number; project: string; sourceFolderDeleted?: boolean; sourceFolderDeleteError?: string }>>;
  };
  secrets: {
    set: (ref: string, value: string) => Promise<TandemResult<boolean>>;
    has: (ref: string) => Promise<TandemResult<boolean>>;
    clear: (ref: string) => Promise<TandemResult<boolean>>;
    setAgentApiKey: (ref: string, value: string) => Promise<TandemResult<boolean>>;
    hasAgentApiKey: (ref: string) => Promise<TandemResult<boolean>>;
    clearAgentApiKey: (ref: string) => Promise<TandemResult<boolean>>;
    validateAgentApiKey: (envName: string, value: string) => Promise<TandemResult<ApiKeyValidationResult>>;
  };
  sessions: {
    list: () => Promise<TandemResult<SessionSummary[]>>;
    get: (id: string) => Promise<TandemResult<SessionDetail | null>>;
    create: (input: CreateSessionInput) => Promise<TandemResult<SessionDetail>>;
    update: (input: UpdateSessionInput) => Promise<TandemResult<SessionDetail>>;
    syncNotStartedBoard: (id: string) => Promise<TandemResult<SessionDetail>>;
    delete: (id: string, options?: { deleteBoardArtifact?: boolean }) => Promise<TandemResult<string | undefined>>;
    download: (id: string) => Promise<TandemResult<string | null>>;
    setHidden: (id: string, hidden: boolean) => Promise<TandemResult<void>>;
    getActive: () => Promise<TandemResult<string | null>>;
    setActive: (id: string | null) => Promise<TandemResult<void>>;
  };
  composer: {
    send: (input: ComposerMessageInput) => Promise<TandemResult<TranscriptEvent>>;
  };
  cards: {
    add: (input: NativeOutputCardInput) => Promise<TandemResult<NativeOutputCard>>;
  };
  handoffs: {
    createDraft: (
      sessionId: string,
      fromSide: AgentSide,
      fromRole: string,
      toSide: AgentSide,
      toRole: string
    ) => Promise<TandemResult<Handoff>>;
    approve: (handoffId: string) => Promise<TandemResult<Handoff | null>>;
  };
  evidence: {
    updateStatus: (
      sessionId: string,
      key: string,
      status: EvidenceStatus,
      ref?: string
    ) => Promise<TandemResult<SessionDetail>>;
    addRecord: (input: EvidenceRecordInput) => Promise<TandemResult<EvidenceRecord>>;
    listRecords: (sessionId: string) => Promise<TandemResult<EvidenceRecord[]>>;
  };
  workflow: {
    recordTaskReview: (
      sessionId: string,
      verdict: "ok" | "changes" | "blocked"
    ) => Promise<TandemResult<SessionDetail>>;
    requestTaskReview: (sessionId: string, commentBody?: string) => Promise<TandemResult<WorkflowActionResult>>;
    applyTaskReviewVerdict: (
      sessionId: string,
      verdict: TaskReviewVerdict,
      commentBody?: string
    ) => Promise<TandemResult<WorkflowActionResult>>;
    deployUat: (sessionId: string) => Promise<TandemResult<WorkflowActionResult>>;
    transition: (sessionId: string, target: WorkflowTransitionTarget) => Promise<TandemResult<WorkflowActionResult>>;
    createFollowUpTasks: (sourceSessionId: string, tasks: ProposedTask[]) => Promise<TandemResult<ProposedTask[]>>;
  };
  conductor: {
    update: (
      sessionId: string,
      patch: Partial<Omit<ConductorSnapshot, "sessionId" | "updatedAt">>
    ) => Promise<TandemResult<SessionDetail>>;
  };
  github: {
    syncIssue: (sessionId: string) => Promise<TandemResult<GitHubIssueContext>>;
    attachIssue: (sessionId: string, repo: string, issueNumber: number) => Promise<TandemResult<SessionDetail>>;
    updateProjectStatus: (sessionId: string, status: string) => Promise<TandemResult<WorkflowActionResult>>;
    authStatus: () => Promise<TandemResult<GitHubAuthStatus>>;
    login: () => Promise<TandemResult<GitHubAuthStatus>>;
    listProjects: () => Promise<TandemResult<GitHubProjectOption[]>>;
    listProjectOwners: () => Promise<TandemResult<GitHubProjectOwnerOption[]>>;
    createProject: (owner: string, title: string) => Promise<TandemResult<GitHubProjectOption>>;
    listWorkspaceRepos: (workspaceRoot: string) => Promise<TandemResult<GitHubRepoOption[]>>;
    // Code repos (Code & Repos): browse account repos, create, inspect/link/push a local folder.
    listRepos: (owner: string, limit?: number) => Promise<TandemResult<GitHubAccountRepo[]>>;
    createRepo: (owner: string, name: string, isPrivate: boolean) => Promise<TandemResult<GitHubAccountRepo>>;
    inspectGitRepo: (path: string) => Promise<TandemResult<GitRepoInspection>>;
    linkRemote: (path: string, owner: string, name: string) => Promise<TandemResult<void>>;
    gitStatusShort: (path: string) => Promise<TandemResult<string>>;
    initialPush: (path: string, message?: string) => Promise<TandemResult<void>>;
  };
  board: {
    syncArtifact: (sessionId: string) => Promise<TandemResult<GitHubIssueContext>>;
    getArtifact: (sessionId: string) => Promise<TandemResult<BoardArtifact | null>>;
    attachArtifact: (sessionId: string, repo: string, issueNumber: number) => Promise<TandemResult<SessionDetail>>;
    createSessionFromArtifact: (
      sourceSessionId: string,
      repo: string,
      issueNumber: number
    ) => Promise<TandemResult<SessionDetail>>;
    createTask: (
      sessionId: string,
      input: { title?: string; body?: string; repo?: string; labels?: string[] }
    ) => Promise<TandemResult<SessionDetail>>;
    updateArtifactBody: (sessionId: string, body: string) => Promise<TandemResult<SessionDetail>>;
    commentArtifact: (sessionId: string, body: string) => Promise<TandemResult<SessionDetail>>;
    // `slot` carries the explicit Twindem target so the move isn't re-derived from an ambiguous
    // (duplicate-mapped) status name. Omit it for external/agent-proposed status names.
    updateStatus: (sessionId: string, status: string, slot?: BoardStatusSlot) => Promise<TandemResult<WorkflowActionResult>>;
    authStatus: () => Promise<TandemResult<GitHubAuthStatus>>;
    connect: () => Promise<TandemResult<GitHubAuthStatus>>;
    listProjects: () => Promise<TandemResult<GitHubProjectOption[]>>;
    listProjectOwners: () => Promise<TandemResult<GitHubProjectOwnerOption[]>>;
    createProject: (owner: string, title: string) => Promise<TandemResult<GitHubProjectOption>>;
    listWorkspaceRepos: (workspaceRoot: string) => Promise<TandemResult<GitHubRepoOption[]>>;
    listArtifacts: (owner: string, projectNumber: number) => Promise<TandemResult<BoardArtifactOption[]>>;
    listWorkspaceArtifacts: (workspaceName?: string) => Promise<TandemResult<BoardArtifactOption[]>>;
    validateJira: (input: { siteUrl: string; email: string; apiToken: string }) => Promise<TandemResult<GitHubAuthStatus>>;
  };
  usage: {
    // Lazy by design: the event list is fetched only when the Cost panel needs it; SessionDetail
    // carries just usageSummary.
    list: (sessionId: string) => Promise<TandemResult<UsageEvent[]>>;
    summary: (sessionId: string) => Promise<TandemResult<UsageSummary | undefined>>;
    workspaceSummary: (workspaceName: string) => Promise<TandemResult<UsageSummary | undefined>>;
  };
  jira: {
    // Draft-credentials path (Onboarding — token not saved yet).
    listProjects: (creds: { siteUrl: string; email: string; apiToken: string }) => Promise<TandemResult<JiraProjectOption[]>>;
    createProject: (
      creds: { siteUrl: string; email: string; apiToken: string },
      input: { key: string; name: string }
    ) => Promise<TandemResult<JiraProjectOption>>;
    // Saved-token path (Settings — token read in main from safeStorage).
    listProjectsForWorkspace: (workspaceName?: string) => Promise<TandemResult<JiraProjectOption[]>>;
    createProjectForWorkspace: (
      workspaceName: string,
      input: { key: string; name: string }
    ) => Promise<TandemResult<JiraProjectOption>>;
    // Real status names for a project, scoped to an issue type when given.
    listProjectStatuses: (
      creds: { siteUrl: string; email: string; apiToken: string },
      projectKey: string,
      issueType?: string
    ) => Promise<TandemResult<JiraProjectStatuses>>;
    listProjectStatusesForWorkspace: (
      workspaceName: string,
      projectKey: string,
      issueType?: string
    ) => Promise<TandemResult<JiraProjectStatuses>>;
  };
  system: {
    checkCommand: (command: string) => Promise<TandemResult<CommandCheckResult>>;
  };
  signals: {
    poll: (sessionId: string) => Promise<TandemResult<AgentSignal[]>>;
    clear: (sessionId: string, side?: AgentSide) => Promise<TandemResult<void>>;
    readIdeaBody: (sessionId: string, consume?: boolean) => Promise<TandemResult<string | null>>;
  };
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
    ) => Promise<TandemResult<string>>;
    isRunning: (side: AgentSide) => Promise<TandemResult<boolean>>;
    runningSession: (side: AgentSide) => Promise<TandemResult<string | undefined>>;
    write: (side: AgentSide, data: string) => Promise<TandemResult<void>>;
    resize: (side: AgentSide, cols: number, rows: number) => Promise<TandemResult<void>>;
    stop: (side: AgentSide) => Promise<TandemResult<void>>;
    clearResume: (sessionId: string, side: AgentSide) => Promise<TandemResult<SessionDetail>>;
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
    ) => Promise<TandemResult<string>>;
    onData: (callback: (payload: { side: AgentSide; data: string; sessionId?: string }) => void) => () => void;
    onExit: (callback: (payload: { side: AgentSide; exitCode: number; sessionId?: string }) => void) => () => void;
  };
};
