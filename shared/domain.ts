export type SessionStatus = "running" | "waiting" | "blocked" | "done";
export type ArtifactType = "idea" | "issue" | "branch" | "pr" | "release";
export type IdeaType = "feature" | "bug" | "spike" | "architecture" | "research" | "runbook";
export type VisiblePhase = "capture" | "define" | "review" | "execute" | "verify" | "done";
export type AgentSide = "L" | "R";
export type AgentStatus = "idle" | "running" | "muted_by_user" | "exited" | "failed" | "interrupted";
export type ProviderKey = "codex" | "claude" | "shell" | string;
export type BoardProviderKey = "github_project" | "jira" | "linear" | string;
export type BoardArtifactKind = "github_issue" | "github_draft" | "jira_issue" | "linear_issue" | string;

export type GitHubProjectOwnerOption = {
  login: string;
  type: "User" | "Organization" | string;
};

export type RoleName =
  | "Author"
  | "Reviewer"
  | "Implementer"
  | "Verifier"
  | "Release Operator"
  | "Researcher";

export type EvidenceStatus = "pending" | "done" | "blocked" | "na";

export type SessionSummary = {
  id: string;
  title: string;
  initialBody?: string;
  artifactType: ArtifactType;
  ideaType?: IdeaType;
  workspaceName?: string;
  repo?: string;
  issueNumber?: number;
  prNumber?: number;
  boardProvider?: BoardProviderKey;
  boardItemId?: string;
  boardItemKey?: string;
  boardItemUrl?: string;
  boardStatus?: string;
  leftRole?: string;
  leftProvider?: string;
  rightRole?: string;
  rightProvider?: string;
  visiblePhase: VisiblePhase;
  internalState: string;
  status: SessionStatus;
  roundN: number;
  roundTotal: number;
  createdAt: string;
  updatedAt: string;
  lastGithubSyncAt?: string;
  // Number of agent CLI runs ever started for this session. 0 + a linked board task + inbox/capture =
  // NOT STARTED (the badge is about work/agent history, not just the board slot).
  agentRunCount: number;
  // Provenance for spawned follow-up tasks (see CreateSessionInput).
  spawnedFromSessionId?: string;
  spawnedFromTaskId?: string;
  spawnedFingerprint?: string;
  spawnedFromBoardRef?: string;
  spawnedOrder?: number;
  // Hidden from the session list (e.g. finished tasks). Still reachable via search.
  hidden?: boolean;
};

export type AgentRunSummary = {
  id: string;
  sessionId: string;
  side: AgentSide;
  role: RoleName;
  provider: ProviderKey;
  nativeSessionId?: string;
  nativeSessionName?: string;
  resumeCommand?: string;
  resumeArgs?: string[];
  status: AgentStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
};

export type TranscriptEventType =
  | "user"
  | "agent"
  | "system"
  | "tool"
  | "pty"
  | "handoff"
  | "workflow"
  | "error";

export type TranscriptEvent = {
  id: string;
  sessionId: string;
  runId?: string;
  side?: AgentSide;
  type: TranscriptEventType;
  content: string;
  createdAt: string;
};

export type NativeOutputCard = {
  id: string;
  sessionId: string;
  side: AgentSide;
  kind: "summary" | "tool" | "artifact" | "verdict" | "result";
  title: string;
  body: string;
  createdAt: string;
};

export type EvidenceItem = {
  id: string;
  sessionId: string;
  key: string;
  title: string;
  status: EvidenceStatus;
  source?: string;
  ref?: string;
  updatedAt: string;
};

// Curated narrative evidence ("what was decided/produced/verified", written for humans), distinct
// from workflow_events (mechanical audit: who/what/when) and evidence_items (gate checklist).
// Not every event becomes evidence — see the dual-write table in the task spec; when in doubt,
// audit-only.
export type EvidenceRecordKind =
  | "brief"
  | "plan"
  | "artifact"
  | "review"
  | "decision"
  | "approval"
  | "test"
  | "deploy"
  | "board_transition"
  | "risk"
  | "follow_up"
  | "note";

export type EvidenceRecord = {
  id: string;
  sessionId: string;
  workspaceName?: string;
  // Writers must use VisiblePhase values; `string` is storage tolerance only — the UI groups
  // unknown values under "other" instead of crashing.
  phase: VisiblePhase | string;
  kind: EvidenceRecordKind;
  title: string;
  summary: string;
  details?: Record<string, unknown>;
  source?: "human" | "agent" | "app" | "board";
  agentSide?: AgentSide;
  rawRef?: string;
  rawPath?: string;
  boardUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceRecordInput = Omit<EvidenceRecord, "id" | "createdAt" | "updatedAt">;

export type WorkflowEvent = {
  id: string;
  sessionId: string;
  action: string;
  actorType: "human" | "agent" | "app";
  actorRole?: RoleName;
  phaseFrom?: string;
  phaseTo?: string;
  result: "ok" | "blocked" | "warned" | "failed";
  userApproved: boolean;
  createdAt: string;
};

export type DeployAttempt = {
  id: string;
  sessionId: string;
  status: "running" | "succeeded" | "failed";
  command: string;
  args: string[];
  output?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
};

export type GitHubIssueContext = {
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
  comments: Array<{
    author: string;
    body: string;
    createdAt: string;
    url?: string;
  }>;
  linkedPrs?: Array<{
    number: number;
    title: string;
    url: string;
    state: string;
  }>;
  projectStatus?: string;
  projectFields?: Record<string, string>;
  fetchedAt: string;
};

export type BoardComment = {
  author: string;
  body: string;
  createdAt: string;
  url?: string;
};

export type BoardArtifact = {
  provider: BoardProviderKey;
  kind: BoardArtifactKind;
  id: string;
  key: string;
  title: string;
  body: string;
  state?: string;
  url?: string;
  labels: string[];
  comments: BoardComment[];
  linkedPrs?: GitHubIssueContext["linkedPrs"];
  status?: string;
  fields?: Record<string, string>;
  fetchedAt: string;
  github?: {
    repo: string;
    issueNumber: number;
  };
};

export type GitHubAuthStatus = {
  ok: boolean;
  message: string;
};

export type GitHubProjectOption = {
  id: string;
  owner: string;
  ownerType?: string;
  number: number;
  title: string;
  url?: string;
  closed?: boolean;
};

export type GitHubRepoOption = {
  fullName: string;
  name: string;
  owner: string;
  path: string;
};

// A repo on the user's GitHub account/org (from `gh repo list`) — no local path.
export type GitHubAccountRepo = {
  owner: string;
  name: string;
  nameWithOwner: string;
  isPrivate: boolean;
  url: string;
};

// The local git state of a chosen folder — source of truth for configured/linked/mismatch.
export type GitRepoInspection = {
  hasGit: boolean;
  hasOrigin: boolean;
  isGitHub: boolean;
  owner?: string;
  name?: string;
  status: "none" | "local_no_origin" | "github_origin" | "other_origin";
  originUrl?: string;
};

export type JiraProjectOption = {
  id: string;
  key: string;
  name: string;
};

export type JiraProjectStatuses = {
  statuses: string[];
  // True when the requested issue type wasn't found and statuses are the union across all issue types.
  unioned: boolean;
};

export type BoardArtifactOption = {
  id: string;
  provider?: BoardProviderKey;
  kind?: BoardArtifactKind;
  type: "Issue" | "Draft";
  key?: string;
  repo?: string;
  issueNumber?: number;
  title: string;
  body?: string;
  url?: string;
  status?: string;
  labels: string[];
};

export type ConductorSnapshot = {
  sessionId: string;
  automationLevel: "manual" | "semi" | "auto";
  currentStepId?: string;
  activeSide?: AgentSide;
  restorePending?: boolean;
  chosenImplementerSide?: AgentSide;
  chosenImplementerProvider?: string;
  ideaRound: number;
  technicalRound: number;
  codeRound: number;
  updatedAt: string;
};

export type TaskReviewVerdict = "requested" | "ok" | "changes" | "blocked";
export type WorkflowTransitionTarget = "uat" | "done";

export type Handoff = {
  id: string;
  sessionId: string;
  fromSide?: AgentSide;
  fromRole: RoleName;
  toSide?: AgentSide;
  toRole: RoleName;
  roundN: number;
  roundTotal: number;
  summary: string;
  evidence: Array<{ key: string; label: string; ref?: string }>;
  status: "draft" | "pending_approval" | "sent" | "cancelled" | "blocked";
  createdAt: string;
  approvedAt?: string;
};

// TUI-mode usage is a VOLUME estimate (terminal bytes/4 after ANSI stripping), recorded one row
// per agent run — never one row per PTY flush. Exact token/cost fields are reserved for a future
// headless/API mode; the UI must label estimates as "estimated terminal context volume".
export type UsageEvent = {
  id: string;
  sessionId: string;
  workspaceName?: string;
  runId?: string;
  agentSide?: AgentSide;
  phase?: VisiblePhase | string;
  provider?: ProviderKey;
  model?: string;
  mode: "tui_estimate" | "headless_actual" | "manual";
  inputEstimateTokens: number;
  outputEstimateTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  source: "composer" | "pty" | "api" | "manual" | "app";
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
};

export type UsageSummary = {
  inputEstimateTokens: number;
  outputEstimateTokens: number;
  totalEstimateTokens: number;
  estimatedCostUsd?: number;
  byAgent: Array<{
    side?: AgentSide;
    provider?: ProviderKey;
    model?: string;
    totalEstimateTokens: number;
    estimatedCostUsd?: number;
  }>;
  byPhase: Array<{
    phase: string;
    totalEstimateTokens: number;
    estimatedCostUsd?: number;
  }>;
};

export type SessionDetail = {
  session: SessionSummary;
  runs: AgentRunSummary[];
  transcript: TranscriptEvent[];
  evidence: EvidenceItem[];
  evidenceRecords: EvidenceRecord[];
  workflowEvents: WorkflowEvent[];
  deployAttempts: DeployAttempt[];
  handoffs: Handoff[];
  outputCards: NativeOutputCard[];
  github?: GitHubIssueContext;
  board?: BoardArtifact;
  conductor?: ConductorSnapshot;
  // Aggregate only — the usage event list stays out of SessionDetail (fetched lazily via
  // usage.list when the Cost panel needs it) because sessions:get is called constantly.
  usageSummary?: UsageSummary;
};

export type NativeOutputCardInput = Omit<NativeOutputCard, "id" | "createdAt"> & {
  createdAt?: string;
};

// InstructionMode describes WHAT KIND of instruction is being sent to an agent. It is orthogonal
// to the task's phase and must never become a third phase vocabulary: phase logic stays on
// VisiblePhase/IdeaPhaseKey; the canonical mapping lives in shared/context-builder.ts.
// "orientation" and "corrections" are cross-cutting: valid in any phase, never derived from it.
export type InstructionMode =
  | "orientation"
  | "plan"
  | "work"
  | "review"
  | "corrections"
  | "approval"
  | "done";

export type RawContextRef = {
  label: string;
  kind: "board" | "transcript" | "log" | "file" | "artifact" | "attachment";
  url?: string;
  path?: string;
};

export type PhasePolicy = {
  requiresImplementation: boolean;
  requiredArtifact: string;
  allowedActions: string[];
  disallowedActions: string[];
  qualityRules: string[];
  requiredSections: string[];
};

export type AgentContextPack = {
  sessionId: string;
  side: AgentSide;
  mode: InstructionMode;
  workspaceName?: string;
  workspaceRoot?: string;
  boardProvider?: BoardProviderKey;
  boardArtifact?: BoardArtifact;
  boardRef?: string;
  boardUrl?: string;
  title: string;
  body?: string;
  ideaType: IdeaType;
  phase: VisiblePhase;
  statusSlot?: string;
  requiresImplementation: boolean;
  requiredArtifact: string;
  allowedActions: string[];
  disallowedActions: string[];
  qualityRules: string[];
  projectDescription?: string;
  projectInstructions?: string;
  // Editable code roots (resolveAllowedRoots) — same list the renderer brief uses.
  allowedRoots?: string[];
  evidenceSummary: EvidenceRecord[];
  rawRefs: RawContextRef[];
};

export type WorkflowActionResult = {
  session: SessionDetail;
  warnings: string[];
};

export type CreateSessionInput = {
  title: string;
  artifactType: ArtifactType;
  ideaType?: IdeaType;
  workspaceName?: string;
  repo?: string;
  issueNumber?: number;
  prNumber?: number;
  boardProvider?: BoardProviderKey;
  boardItemId?: string;
  boardItemKey?: string;
  boardItemUrl?: string;
  branchName?: string;
  issueBody?: string;
  createGithubIssue?: boolean;
  leftRole?: string;
  leftProvider?: string;
  rightRole?: string;
  rightProvider?: string;
  roundTotal?: number;
  automationLevel?: "manual" | "semi" | "auto";
  // Absolute paths of files picked by the user; copied into <workspace>/.twindem/attachments/
  // at creation and listed in the session brief so agents inspect them (images are readable
  // directly by the agent CLIs; archives get unzipped and reviewed).
  attachments?: string[];
  // Intake-only: create a local session/list item, but do not activate it or brief/start agents.
  localOnly?: boolean;
  // Quick-capture mode: a short note that goes straight onto the board with a [Short] title tag,
  // skipping the full idea/bug form. Agent 1 introduces it and offers to discuss.
  quickNote?: boolean;
  quickNoteKind?: "idea" | "bug";
  // Provenance for tasks spawned from an Architecture ADR (or other follow-up flow). Carried so the
  // Tasks list can show lineage, keep stable order, and dedupe — no text parsing needed.
  spawnedFromSessionId?: string;
  spawnedFromTaskId?: string;
  spawnedFingerprint?: string;
  spawnedFromBoardRef?: string;
  spawnedOrder?: number;
};

export type UpdateSessionInput = {
  id: string;
  title: string;
  initialBody?: string;
  ideaType?: IdeaType;
};

export type ComposerMessageInput = {
  sessionId: string;
  target: AgentSide;
  text: string;
  muteOther?: boolean;
};

// Structured review finding: the unit of the delta review protocol. IDs are stable within one
// review loop so corrections rounds can reference "F2, F5" instead of re-sending full context.
export type ReviewFinding = {
  id: string;
  severity: "blocking" | "non_blocking";
  file?: string;
  line?: number;
  title: string;
  detail: string;
  status: "open" | "addressed" | "verified" | "waived";
};

export type ProposedTask = {
  id: string;
  status: "proposed" | "selected" | "created" | "skipped" | "failed";
  title: string;
  type: IdeaType;
  summary: string;
  acceptanceCriteria?: string;
  targetRepo?: string;
  fingerprint?: string;
  boardRef?: string;
  url?: string;
  error?: string;
};

// File-based agent signal (.twindem/signals/<sessionId>.<A1|A2>.json) replacing the old
// TWINDEM_DONE/TWINDEM_TASK markers scraped from the TUI byte stream (which echoed back).
export type AgentSignalVerdict = "OK" | "Changes requested" | "Blocked";
export type AgentSignal = {
  side: AgentSide;
  phase: string;
  verdict?: AgentSignalVerdict;
  // For {"phase":"status"} proposals: the board status A1 assessed from the issue's progress.
  status?: string;
  // For {"phase":"review"} verdicts: Agent 2's structured findings (delta review protocol).
  findings?: ReviewFinding[];
  // For {"phase":"tasks"} proposals: Agent 1's structured follow-up implementation tasks.
  tasks?: ProposedTask[];
};
