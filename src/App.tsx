import { Fragment, type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./App.css";
import twindemLogo from "./assets/twindem-logo.png";
import type {
  AgentSide,
  AgentSignal,
  AgentRunSummary,
  BoardArtifactOption,
  CreateSessionInput,
  EvidenceItem,
  EvidenceStatus,
  Handoff,
  GitHubAuthStatus,
  GitHubIssueContext,
  GitHubProjectOption,
  GitHubProjectOwnerOption,
  GitHubRepoOption,
  NativeOutputCard,
  ProposedTask,
  ReviewFinding,
  SessionDetail,
  SessionSummary,
  TaskReviewVerdict,
  UpdateSessionInput,
  UsageSummary,
  WorkflowTransitionTarget,
  WorkflowActionResult
} from "../shared/domain";
import type { IdeaType, JiraProjectOption, VisiblePhase } from "../shared/domain";
import type { BoardStatusSlot, TandemConfig } from "../shared/config";
import { boardProviderForWorkspace, defaultWorkspaceStatusMapping, isDeployableWorkspace, resolveAllowedRoots } from "../shared/config";
import type { CommandCheckResult, TandemResult } from "../shared/api";
import { IDEA_TYPES, ideaTypeDefinition, labelsForIdeaType, inferIdeaType } from "../shared/idea-types";
import {
  buildAgentContextPack,
  qualityRuleLines,
  renderAgentContextBrief,
  renderCompactRestartHandoff
} from "../shared/context-builder";
import {
  BriefPanel,
  CompactEvidencePanel,
  CostSummaryPanel,
  DecisionEvidencePanel,
  GovernancePanel,
  RawRefsPanel
} from "./components/TaskContextDrawer";
import { stripAnsi } from "../shared/text";
import type { BoardHelpTopic } from "./components/BoardHelpLinks";
import { BoardSetupFields } from "./components/BoardSetupFields";
import { StatusMappingEditor, type StatusMappingValue } from "./components/StatusMappingEditor";
import { ProjectLayoutEditor, type ProjectLayoutEntry } from "./components/ProjectLayoutEditor";
import { RepoField } from "./components/RepoField";
import {
  autoMapRead,
  autoMapWrite,
  boardColumnSortKeyForStatus,
  boardStatusForSlot,
  boardStatusOptions,
  boardStatusPhaseLabel,
  MAIN_TRACK_STATUS_SLOTS,
  phaseIndexForSlot,
  PROPOSABLE_STATUS_SLOTS,
  slotForBoardStatus,
  statusLabelForVisiblePhase,
  unaccountedStatuses,
  isRealBoardStatus
} from "../shared/status-mapping";

type PaneState = {
  side: AgentSide;
  roles: string[];
  provider: string;
  status: "idle" | "running" | "muted";
};

type AgentOutputCard = NativeOutputCard;

type ParsedTwindemResult = {
  marker?: "IDEA APPROVED" | "DOR MET" | "IMPLEMENTATION READY" | "CODE APPROVED";
  verdict?: "OK" | "Changes requested" | "Blocked";
  summary?: string;
  nextAction?: string;
  issueUrl?: string;
  evidence?: string[];
  confidence?: number;
  needsHuman?: boolean;
  validationError?: string;
};

type WorkflowModalState = {
  verdict: TaskReviewVerdict;
  title: string;
  confirmLabel: string;
  body: string;
};

type EvidenceModalState = {
  key: string;
  status: Extract<EvidenceStatus, "blocked" | "na">;
  reason: string;
};

type AttachIssueModalState = {
  ref: string;
  continueToReview: boolean;
};

type IssueEditModalState = {
  mode: "body" | "comment";
  title: string;
  body: string;
};

type SessionEditModalState = {
  id: string;
  title: string;
  initialBody: string;
  ideaType: IdeaType;
  notStarted: boolean;
};

type DeleteSessionModalState = {
  id: string;
  title: string;
  repo?: string;
  issueNumber?: number;
  boardProvider?: string;
  boardItemId?: string;
  boardItemKey?: string;
  deleteBoardArtifact: boolean;
};

type SessionPreviewModalState = {
  detail: SessionDetail;
  openedFrom: "session-list" | "board-card";
};

type FolderTrustModalState = {
  side: AgentSide;
};

type TaskProposalModalState = {
  sourceSessionId: string;
  sourceBoardRef: string;
  tasks: ProposedTask[];
  creating: boolean;
};

type NativeGateModalState =
  | { kind: "start-planning"; title: string; body: string }
  | { kind: "choose-implementer"; title: string; body: string; side: AgentSide; provider: string }
  | { kind: "approve-uat"; title: string; body: string; mode: "deploy" | "approval"; confirmLabel?: string }
  | { kind: "max-rounds"; title: string; body: string };

type PermissionPromptModalState = {
  side: AgentSide;
  title: string;
  reason: string;
  commandPreview: string;
  rememberPrefix?: string;
  detectedAt: string;
};

type AutomationLevel = "manual" | "auto";
type NativeFlowKind = "agent1" | "agent2" | "loop" | "gate" | "status";

type NativeFlowStep = {
  id: string;
  status: BoardStatusSlot;
  kind: NativeFlowKind;
  title: string;
  subtitle: string;
  stopMarker?: string;
};

type ConductorState = {
  currentStepId: string;
  nextStepId?: string;
  checkpointTitle: string;
  checkpointBody: string;
  checkpointTone: "accent" | "amber" | "green" | "red";
  primaryAction: string;
  primaryDisabled?: boolean;
  marker?: string;
  round: { n: number; total: number };
};

type TurnIndicator =
  | { kind: "agent"; side: AgentSide }
  | { kind: "human" }
  | { kind: "none" };

type BoardType = "github" | "jira" | "none";
type OnboardingMode = "setup" | "new-project";
type AgentAuthMode = "none" | "subscription" | "api_key";
const SETUP_VERSION = 1;
const DEFAULT_AGENT_1_ROLES = ["Author", "Implementer", "Verifier"];
const DEFAULT_AGENT_2_ROLES = ["Reviewer", "Release Operator", "Researcher"];

const NATIVE_FLOW_STEPS: NativeFlowStep[] = [
  {
    id: "idea-proposal",
    status: "inbox",
    kind: "agent1",
    title: "Agent 1 - propose idea",
    subtitle: "Create/attach issue and development plan"
  },
  {
    id: "idea-review-loop",
    status: "inbox",
    kind: "loop",
    title: "Idea review loop",
    subtitle: "Agent 2 reviews, Agent 1 updates",
    stopMarker: "IDEA APPROVED"
  },
  {
    id: "planning-gate",
    status: "inbox",
    kind: "gate",
    title: "Human gate: start planning?",
    subtitle: "Confirm transition to technical analysis"
  },
  {
    id: "technical-analysis",
    status: "planning",
    kind: "agent1",
    title: "Agent 1 - technical analysis",
    subtitle: "Implementation design, task update"
  },
  {
    id: "technical-review-loop",
    status: "planning",
    kind: "loop",
    title: "Technical review loop",
    subtitle: "Agent 2 reviews, Agent 1 refines",
    stopMarker: "DOR MET"
  },
  {
    id: "definition-ready",
    status: "planning",
    kind: "status",
    title: "Definition of Ready",
    subtitle: "Task can be queued for implementation"
  },
  {
    id: "implementer-gate",
    status: "planning",
    kind: "gate",
    title: "Human gate: choose implementer",
    subtitle: "Pick which agent writes the change"
  },
  {
    id: "implementation",
    status: "in_progress",
    kind: "agent2",
    title: "Agent 2 - implement",
    subtitle: "Code according to DoR and record tests"
  },
  {
    id: "code-review-loop",
    status: "in_progress",
    kind: "loop",
    title: "Code review loop",
    subtitle: "Agent 1 reviews, Agent 2 fixes",
    stopMarker: "CODE APPROVED"
  },
  {
    id: "uat-gate",
    status: "in_progress",
    kind: "gate",
    title: "Human gate: approve UAT deploy",
    subtitle: "Real infrastructure action"
  },
  {
    id: "uat-deploy",
    status: "uat",
    kind: "status",
    title: "Deploy to UAT",
    subtitle: "Deploy evidence required"
  },
  {
    id: "uat-validation",
    status: "uat",
    kind: "status",
    title: "UAT validation",
    subtitle: "Smoke tests and final verification"
  }
];

// Did the latest review already pass? Derived from the durable workflow log (signal.consumed
// events, newest first): if the most recent author/reviewer signal is an A2 review verdict of OK,
// the current phase's review is done — reopening should not re-run it.
function lastReviewPassedFromEvents(events: Array<{ action: string; phaseTo?: string | null }>): boolean {
  for (const event of events) {
    if (event.action === "signal.consumed.A2" && /review/i.test(event.phaseTo ?? "")) {
      return /\bOK\b/i.test(event.phaseTo ?? "");
    }
    if (event.action === "signal.consumed.A1") return false; // newer author work → pending re-review
  }
  return false;
}

type SessionFilterKey =
  | "all"
  | "today"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "lastMonth"
  | "thisYear"
  | "lastYear";
const SESSION_FILTERS: Array<{ key: SessionFilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "thisWeek", label: "This week" },
  { key: "lastWeek", label: "Last week" },
  { key: "thisMonth", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "thisYear", label: "This year" },
  { key: "lastYear", label: "Last year" }
];

function sessionMatchesTimeFilter(updatedAt: string, filter: SessionFilterKey): boolean {
  if (filter === "all") return true;
  const dayMs = 86400000;
  const startOfDay = (value: Date) => {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const now = new Date();
  const today = startOfDay(now);
  const when = new Date(updatedAt);
  const day = startOfDay(when);
  const diffDays = Math.round((today - day) / dayMs);
  if (filter === "today") return diffDays === 0;
  if (filter === "yesterday") return diffDays === 1;
  const mondayOffset = (new Date(today).getDay() + 6) % 7; // 0 = Monday
  const weekStart = today - mondayOffset * dayMs;
  if (filter === "thisWeek") return day >= weekStart;
  if (filter === "lastWeek") return day >= weekStart - 7 * dayMs && day < weekStart;
  const y = now.getFullYear();
  const m = now.getMonth();
  if (filter === "thisMonth") return when.getFullYear() === y && when.getMonth() === m;
  if (filter === "lastMonth") {
    const lm = m === 0 ? 11 : m - 1;
    const lmYear = m === 0 ? y - 1 : y;
    return when.getFullYear() === lmYear && when.getMonth() === lm;
  }
  if (filter === "thisYear") return when.getFullYear() === y;
  if (filter === "lastYear") return when.getFullYear() === y - 1;
  return true;
}

const defaultPanes: Record<AgentSide, PaneState> = {
  L: { side: "L", roles: ["Author"], provider: "shell", status: "idle" },
  R: { side: "R", roles: ["Reviewer"], provider: "shell", status: "idle" }
};

const SIDEBAR_WIDTH_KEY = "twindem.sidebarWidth";
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_DEFAULT_WIDTH = 258;
const AUTO_LOOP_TOTAL_VOLUME_LIMIT = 120_000;
const AUTO_LOOP_AGENT_VOLUME_LIMIT = 80_000;

function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

function initialSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT_WIDTH;
}

function App() {
  const [config, setConfig] = useState<TandemConfig | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [panes, setPanes] = useState(defaultPanes);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingMode, setOnboardingMode] = useState<OnboardingMode>("setup");
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [githubAuthStatus, setGithubAuthStatus] = useState<GitHubAuthStatus | null>(null);
  const [githubAuthChecking, setGithubAuthChecking] = useState(false);
  const [automationLevel, setAutomationLevel] = useState<AutomationLevel>("auto");
  const [switchingAgent, setSwitchingAgent] = useState<AgentSide | null>(null);
  const [phaseActionPending, setPhaseActionPending] = useState<string | null>(null);
  const [paneView, setPaneView] = useState<"tabs" | "split">("tabs");
  const [activeTab, setActiveTab] = useState<AgentSide>("L");
  const [lastActiveSide, setLastActiveSide] = useState<AgentSide | undefined>(undefined);
  const [contextOpen, setContextOpen] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [rollbackMenuOpen, setRollbackMenuOpen] = useState(false);
  const [boardModalOpen, setBoardModalOpen] = useState(false);
  // Report Bug: a UAT finding on the current task, vs a new Bug linked to a Done task.
  const [uatFindingModal, setUatFindingModal] = useState<{ sessionId: string; text: string; sendBack: boolean } | null>(null);
  const [bugParent, setBugParent] = useState<{ key: string; repo?: string; issueNumber?: number; title: string; url?: string } | null>(null);
  const [boardArtifacts, setBoardArtifacts] = useState<BoardArtifactOption[]>([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardSyncedAt, setBoardSyncedAt] = useState<string | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionFilter, setSessionFilter] = useState<SessionFilterKey>("all");
  const [sessionFilterOpen, setSessionFilterOpen] = useState(false);
  // Shown while a board card is being opened into a session (the 4-5s GitHub sync).
  const [openingArtifact, setOpeningArtifact] = useState<string | null>(null);
  // Status chosen in the Rollback dropdown — applied when Agent 2's rollback signal arrives.
  const pendingRollbackStatusRef = useRef<string | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [terminalAttention, setTerminalAttention] = useState(false);
  const [workflowModal, setWorkflowModal] = useState<WorkflowModalState | null>(null);
  const [evidenceModal, setEvidenceModal] = useState<EvidenceModalState | null>(null);
  const [attachIssueModal, setAttachIssueModal] = useState<AttachIssueModalState | null>(null);
  const [issueEditModal, setIssueEditModal] = useState<IssueEditModalState | null>(null);
  const [sessionEditModal, setSessionEditModal] = useState<SessionEditModalState | null>(null);
  const [deleteSessionModal, setDeleteSessionModal] = useState<DeleteSessionModalState | null>(null);
  const [sessionPreviewModal, setSessionPreviewModal] = useState<SessionPreviewModalState | null>(null);
  const [folderTrustModal, setFolderTrustModal] = useState<FolderTrustModalState | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [taskProposalModal, setTaskProposalModal] = useState<TaskProposalModalState | null>(null);
  // Immediate "working…" feedback for the Propose-tasks button: switching to Agent 1 can take several
  // seconds before any visible sign, so the button shows a spinner the instant it's clicked.
  const [proposingTasks, setProposingTasks] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);
  const [nativeGateModal, setNativeGateModal] = useState<NativeGateModalState | null>(null);
  const [workflowWarnings, setWorkflowWarnings] = useState<string[]>([]);
  const [sessionMenuOpen, setSessionMenuOpen] = useState<string | null>(null);
  const [sessionMenuAnchor, setSessionMenuAnchor] = useState<{ top: number; right: number } | null>(null);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  // Set true to abort an in-flight agent switch (submitInstruction checks it after each await).
  const switchCancelRef = useRef(false);
  const [reviewPassed, setReviewPassed] = useState(false);
  const [skipPhaseConfirm, setSkipPhaseConfirm] = useState<{ targetKey: string; targetLabel: string; skipped: string[] } | null>(null);
  const restartablePhaseRef = useRef<{ sessionId: string; key: string; reachedIndex: number } | null>(null);
  // Which ping-pong handoff is pending (Manual mode highlights the button): A1 is ready → review,
  // or A2 requested changes → send findings to A1.
  const [pendingHandoff, setPendingHandoff] = useState<null | "review" | "findings">(null);
  const streamBuffers = useRef<Record<AgentSide, string>>({ L: "", R: "" });
  const handledMarkers = useRef(new Set<string>());
  // After sending an instruction, the agent's CLI echoes the prompt (which may contain
  // TWINDEM_RESULT/TWINDEM_BODY template text). Suppress stream parsing until this deadline —
  // a deadline (vs a boolean + timer) survives overlapping sends without ending the window early.
  const markerSuppressedUntil = useRef<Record<AgentSide, number>>({ L: 0, R: 0 });
  // Serializes marker handling so a single agent message can't fire several handoffs at once.
  // Whose output we've already acted on this turn: "R" = handed to A2 (ignore A1's lingering "ready"),
  // "L" = handed to A1 (ignore A2's lingering verdict). Prevents re-firing on TUI redraws.
  const awaitingSide = useRef<AgentSide | null>(null);
  const agentReadyResolvers = useRef<Record<AgentSide, (() => void) | null>>({ L: null, R: null });
  const folderTrustResolver = useRef<((approved: boolean) => void) | null>(null);
  const handledPermissionPrompts = useRef(new Set<string>());
  const handledIssueLinks = useRef(new Set<string>());
  const catchUpInFlight = useRef<string | null>(null);
  // Set when a resume is deferred (owned-known session): the NEXT real work instruction prepends a
  // statement-only orientation once, instead of paying a catch-up interrogation turn on reopen.
  const resumeOrientationPending = useRef<string | null>(null);
  const reviewRoundRef = useRef(0);
  const phaseActionPendingRef = useRef<string | null>(null);
  // Structured findings from Agent 2's latest "Changes requested" verdict — the delta review
  // protocol's working set. Statuses flip to "addressed" when corrections are sent to A1, so the
  // re-review round verifies exactly that delta. Cleared on OK.
  const lastReviewFindingsRef = useRef<ReviewFinding[]>([]);
  // Bumped on every session switch. Long-running async flows (briefings, agent starts) capture it
  // when they begin and bail after each await if it moved — so a flow started for session A can't
  // clobber UI state or talk to agents once the user has switched to session B.
  const sessionEpochRef = useRef(0);
  const previewEpochRef = useRef(0);
  const detailRef = useRef<SessionDetail | null>(null);
  const panesRef = useRef(defaultPanes);
  const configRef = useRef<TandemConfig | null>(null);
  const automationLevelRef = useRef<AutomationLevel>("auto");

  const activeSession = detail?.session;
  const activeWorkspaceName = config?.defaults.workspaceName ?? config?.workspaces[0]?.name;

  const visibleSessions = useMemo(() => {
    const needle = sessionSearch.trim().toLowerCase();
    return sessions.filter((session) => {
      if (activeWorkspaceName && (session.workspaceName ?? activeWorkspaceName) !== activeWorkspaceName) return false;
      if (!sessionMatchesTimeFilter(session.updatedAt, sessionFilter)) return false;
      // Hidden sessions stay out of the list — but a search still surfaces them.
      if (session.hidden && !needle) return false;
      if (!needle) return true;
      return `${session.title} ${session.repo ?? ""} ${session.issueNumber ?? ""}`.toLowerCase().includes(needle);
    });
  }, [sessions, sessionSearch, sessionFilter, activeWorkspaceName]);

  // Group the task list into Active / Not started / Done, each with its own ordering.
  const taskSections = useMemo(() => {
    const active: SessionSummary[] = [];
    const notStarted: SessionSummary[] = [];
    const done: SessionSummary[] = [];
    for (const session of visibleSessions) {
      const where = taskSection(session, config ? activeWorkspace(config, session.workspaceName) : undefined);
      if (where === "done") done.push(session);
      else if (where === "not_started") notStarted.push(session);
      else active.push(session);
    }
    active.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    // Manually added tasks should surface first (newest on top). Spawned follow-ups keep their
    // stable T1…Tn order after them, so architecture-generated batches remain easy to scan.
    notStarted.sort((a, b) => {
      const aSpawned = a.spawnedOrder != null;
      const bSpawned = b.spawnedOrder != null;
      if (aSpawned !== bSpawned) return aSpawned ? 1 : -1;
      if (!aSpawned && !bSpawned) return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      return (a.spawnedOrder ?? 0) - (b.spawnedOrder ?? 0) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    });
    done.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { active, notStarted, done };
  }, [visibleSessions, config]);
  const [doneCollapsed, setDoneCollapsed] = useState(true);

  async function toggleSessionHidden(session: SessionSummary) {
    setSessionMenuOpen(null);
    await run(async () => {
      await unwrap(window.tandem.sessions.setHidden(session.id, !session.hidden));
      setSessions(await unwrap(window.tandem.sessions.list()));
      setNotice(session.hidden ? "Session unhidden." : "Session hidden — find it via search.");
    });
  }

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  // On session load/switch, rehydrate the delta-review findings from durable evidence so the
  // protocol survives an app reload. Keyed on session id only: it must NOT clobber the live ref
  // (updated by the signal handler) on every poll-driven detail refresh within the same session.
  useEffect(() => {
    if (detail) lastReviewFindingsRef.current = latestStructuredFindings(detail);
    restartablePhaseRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.session.id]);

  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    automationLevelRef.current = automationLevel;
  }, [automationLevel]);


  useEffect(() => {
    async function bootstrap() {
      try {
        const [loadedConfig, loadedSessions] = await Promise.all([
          unwrap(window.tandem.config.get()),
          unwrap(window.tandem.sessions.list())
        ]);
        const configWithSessionProjects = ensureUsableActiveWorkspace(ensureSessionWorkspaces(loadedConfig, loadedSessions));
        const activeConfig =
          configWithSessionProjects === loadedConfig
            ? loadedConfig
            : await unwrap(window.tandem.config.save(configWithSessionProjects));
        setConfig(activeConfig);
        setPanes(panesFromConfig(activeConfig));
        setSessions(loadedSessions);

        if (needsOnboarding(activeConfig)) {
          setOnboardingOpen(true);
          return;
        }

        // Do NOT auto-open a session on launch — the CLIs aren't ready and it would mix contexts.
        // Show the empty state with nothing selected; the user picks a session or starts a new one.
        await unwrap(window.tandem.sessions.setActive(null));
        void recoverIssueLinksFromSessions(loadedSessions);
      } catch (error) {
        setBootError(error instanceof Error ? error.message : String(error));
      } finally {
        setBootstrapping(false);
      }
    }

    void bootstrap();
  }, []);

  useEffect(() => {
    const offNewProject = window.tandem.app.onNewProject(() => {
      setOnboardingMode("new-project");
      setOnboardingOpen(true);
    });
    const offOpenSettings = window.tandem.app.onOpenSettings(() => {
      void openSettings();
    });
    const offOpenProjects = window.tandem.app.onOpenProjects(() => {
      setProjectsOpen(true);
    });
    // Backfill (or any main-side task creation) finished — re-list so new NOT STARTED tasks appear.
    const offTasksChanged = window.tandem.app.onTasksChanged(() => {
      void window.tandem.sessions.list().then((r) => {
        if (r.ok) setSessions(r.data);
      });
    });
    const offAbout = window.tandem.app.onAbout(() => setAboutOpen(true));
    void window.tandem.app.version().then((r) => {
      if (r.ok) setAppVersion(r.data);
    });
    return () => {
      offNewProject();
      offOpenSettings();
      offOpenProjects();
      offTasksChanged();
      offAbout();
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!terminalAttention) return;
    const clearAttention = () => setTerminalAttention(false);
    window.addEventListener("pointerdown", clearAttention, { once: true });
    window.addEventListener("keydown", clearAttention, { once: true });
    return () => {
      window.removeEventListener("pointerdown", clearAttention);
      window.removeEventListener("keydown", clearAttention);
    };
  }, [terminalAttention]);

  useEffect(() => {
    const offData = window.tandem.agents.onData((payload) => {
      const side = payload.side;
      const cleaned = stripAnsi(payload.data).trim();
      if (!cleaned || cleaned.startsWith("[Twindem] started")) return;

      if (agentReadyResolvers.current[side]) {
        agentReadyResolvers.current[side]!();
        agentReadyResolvers.current[side] = null;
      }

      const payloadSessionId = payload.sessionId;
      const activeSessionId = detailRef.current?.session.id;
      const isActiveSession = !payloadSessionId || payloadSessionId === activeSessionId;
      if (!isActiveSession) return;

      // Note: structured cards come only from parsed TWINDEM_RESULT blocks below.
      // We no longer scrape the TUI byte stream into heuristic cards (that produced garbage);
      // the live agent output is shown faithfully by the terminal emulator instead.
      streamBuffers.current[side] = `${streamBuffers.current[side]}\n${cleaned}`.slice(-40000);
      if (isInvalidResumeOutput(cleaned)) {
        void handleInvalidResume(side, cleaned);
      }
      if (parseTrustPrompt(streamBuffers.current[side])) {
        setTerminalAttention(true);
        setNotice(`${side === "L" ? "Agent 1" : "Agent 2"} needs folder trust approval in its terminal. Approve it there, then resend/start the step.`);
      }
      // We do NOT pop a modal for the agent's permission questions — the user answers them directly
      // in the terminal, keeping the conversation feel. We only raise a soft toast so a question from
      // the agent that isn't in the visible tab doesn't go unnoticed. Dedup keeps it from spamming.
      const permissionPrompt = parsePermissionPrompt(side, streamBuffers.current[side]);
      if (permissionPrompt) {
        const key = `${permissionPrompt.side}:${permissionPrompt.commandPreview}:${permissionPrompt.reason}`.slice(0, 600);
        if (!handledPermissionPrompts.current.has(key)) {
          handledPermissionPrompts.current.add(key);
          setTerminalAttention(true);
          setNotice(`${side === "L" ? "Agent 1" : "Agent 2"} is asking something in its terminal — answer it there.`);
        }
      }
      // No stream-side marker/result parsing anymore: handoffs come from signal files, and the
      // legacy TWINDEM_RESULT cards were echo noise the user asked to remove.
    });
    return offData;
    // The listener uses refs for live detail/pane/config state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep pane state honest when an agent process dies: without this, a dead agent kept showing
  // "running", handoffs were approved into a dead PTY, and Stop/Start misjudged state.
  useEffect(() => {
    const offExit = window.tandem.agents.onExit((payload) => {
      void (async () => {
        // On restart the old process's exit arrives after the replacement started — don't mark
        // the fresh process idle.
        const stillRunning = await window.tandem.agents
          .isRunning(payload.side)
          .then((r) => r.ok && r.data)
          .catch(() => false);
        if (stillRunning) return;
        const wasRunning = panesRef.current[payload.side].status === "running";
        setPanes((prev) => ({ ...prev, [payload.side]: { ...prev[payload.side], status: "idle" } }));
        if (wasRunning) {
          setNotice(`${payload.side === "L" ? "Agent 1" : "Agent 2"} exited (code ${payload.exitCode}).`);
        }
      })();
    });
    return offExit;
  }, []);

  // Every open dropdown closes on any outside click (scrims help, but this covers all paths,
  // including clicks that land on elements with their own handlers).
  useEffect(() => {
    if (!rollbackMenuOpen && !moreActionsOpen && !sessionMenuOpen && !sessionFilterOpen) return;
    function onDocMouseDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (rollbackMenuOpen && !target.closest(".rollback-wrap")) setRollbackMenuOpen(false);
      if (moreActionsOpen && !target.closest(".more-actions-wrap")) setMoreActionsOpen(false);
      if (sessionMenuOpen && !target.closest(".session-card-menu-wrap, .session-card-menu")) setSessionMenuOpen(null);
      if (sessionFilterOpen && !target.closest(".session-filter-wrap")) setSessionFilterOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [rollbackMenuOpen, moreActionsOpen, sessionMenuOpen, sessionFilterOpen]);

  // Poll for file-based agent signals (.twindem/signals/<sessionId>.<A1|A2>.json). This replaces
  // scraping TWINDEM_DONE/TWINDEM_TASK markers from the TUI stream: the TUI echoes the injected
  // prompt and wraps long lines, so marker fragments landed on their own line in scrollback and
  // re-fired handoffs forever (the infinite review↔fix loop). Files can't echo.
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    const interval = window.setInterval(() => {
      if (cancelled || polling) return;
      const current = detailRef.current;
      if (!current) return;
      polling = true;
      void (async () => {
        try {
          const result = await window.tandem.signals.poll(current.session.id);
          if (!result.ok || cancelled) return;
          for (const signal of result.data) {
            try {
              await handleAgentSignal(signal, current.session.id);
            } catch (error) {
              // The signal file is already consumed — if the auto handoff died (agent down, gh
              // failure), the loop must NOT stall silently. Surface it and light the manual
              // button as a retry path.
              awaitingSide.current = null;
              setPendingHandoff(signal.side === "L" ? "review" : "findings");
              const message = error instanceof Error ? error.message : String(error);
              setErrorNotice(`Automatic handoff failed: ${message} — use the highlighted button to retry.`);
            }
          }
        } catch {
          /* polling is best-effort; next tick retries */
        } finally {
          polling = false;
        }
      })();
    }, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // Handlers read live state via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(operation: () => Promise<void>): Promise<void> {
    setErrorNotice(null);
    await reportErrors(operation, setErrorNotice);
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.classList.add("sidebar-resizing");
    const onMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };
    const onUp = (upEvent: PointerEvent) => {
      const finalWidth = clampSidebarWidth(startWidth + upEvent.clientX - startX);
      setSidebarWidth(finalWidth);
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(finalWidth));
      document.body.classList.remove("sidebar-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const onCancel = () => {
      document.body.classList.remove("sidebar-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  function appendAgentCard(card: AgentOutputCard) {
    if (!shouldDisplayAgentCard(card)) return;
    void window.tandem.cards.add({
      sessionId: card.sessionId,
      side: card.side,
      kind: card.kind,
      title: card.title,
      body: card.body,
      createdAt: card.createdAt
    });
  }

  // A board task sitting with NO status is invisible on the board's main track.
  // The status reflects PROGRESS (the bug-ness lives in the label), so we don't guess it here:
  // we re-sync (a status set on GitHub meanwhile must win), and if it's still empty, A1's
  // catch-up briefing asks it to assess the issue's actual progress and propose a status via a
  // {"phase":"status"} signal (applied in applyProposedBoardStatus).
  // Sync the board (the source of truth) and return the fresh detail. Returns the original on
  // failure so callers always have something usable.
  async function ensureBoardStatusDefault(loaded: SessionDetail): Promise<SessionDetail> {
    if (!loaded.session.repo || !loaded.session.issueNumber) return loaded;
    try {
      await window.tandem.board.syncArtifact(loaded.session.id);
      const updated = await window.tandem.sessions
        .get(loaded.session.id)
        .then((r) => (r.ok ? r.data : null))
        .catch(() => null);
      if (updated) {
        if (detailRef.current?.session.id === loaded.session.id) setDetail(updated);
        return updated;
      }
    } catch {
      /* best-effort */
    }
    return loaded;
  }

  // Apply A1's progress assessment for a no-status issue — but never overwrite a status that
  // appeared in the meantime (the board wins over the agent's proposal).
  async function applyProposedBoardStatus(proposed: string) {
    const detailNow = detailRef.current;
    if (!detailNow || !isBoardSession(detailNow)) return;
    const workspace = config ? activeWorkspace(config, detailNow.session.workspaceName) : undefined;
    const slot = slotForBoardStatus(proposed, workspace);
    if (!slot || !PROPOSABLE_STATUS_SLOTS.includes(slot)) {
      setNotice(`Agent 1 proposed an unknown board status ("${proposed}") — set it manually from the status bar.`);
      return;
    }
    if (isRealBoardStatus(boardStatusForSession(detailNow))) return;
    const canonical = boardStatusForSlot(slot, workspace);
    await run(async () => {
      await unwrap(window.tandem.board.updateStatus(detailNow.session.id, canonical));
      const updated = await unwrap(window.tandem.sessions.get(detailNow.session.id));
      if (updated && detailRef.current?.session.id === detailNow.session.id) setDetail(updated);
      setSessions(await unwrap(window.tandem.sessions.list()));
      setNotice(`Agent 1 assessed the progress — issue placed in ${canonical}.`);
    });
  }

  async function isA1LiveOnSession(candidate: SessionDetail): Promise<boolean> {
    if (detailRef.current?.session.id !== candidate.session.id) return false;
    return unwrap(window.tandem.agents.isRunning("L")).catch(() => false);
  }

  async function activateSessionWithCatchup(target: SessionDetail, opts?: { skipBriefing?: boolean; forceBriefing?: boolean }) {
    sessionEpochRef.current += 1;
    resumeOrientationPending.current = null;
    setWelcomeDismissed(null);
    setReviewPassed(false);
    setPendingHandoff(null);
    reviewRoundRef.current = 0;
    awaitingSide.current = null;
    // The previous session's stream output must not leak into this one (parseTwindemBody reads the
    // LAST TWINDEM_BODY block — a stale one would become this session's issue body).
    streamBuffers.current = { L: "", R: "" };
    const epoch = sessionEpochRef.current;
    // Drop any signal files left over from a previous run so they can't fire on open.
    await window.tandem.signals.clear(target.session.id).catch(() => undefined);
    await run(async () => {
      if (sessionEpochRef.current !== epoch) return;
      detailRef.current = target;
      setDetail(target);
      await unwrap(window.tandem.sessions.setActive(target.session.id));
      if (config) {
        setAutomationLevel(normalizeAutomation(target.conductor?.automationLevel ?? config.defaults.automationLevel));
        const targetPanes = panesFromSession(target, config);
        panesRef.current = targetPanes;
        setPanes(targetPanes);
        // The BOARD is the source of truth — sync it FIRST, then build the catch-up and restore the
        // review state from the freshly-synced data (not a stale local cache).
        let current = target;
        if (target.session.repo && target.session.issueNumber) {
          current = await ensureBoardStatusDefault(target);
          if (sessionEpochRef.current !== epoch) return;
          detailRef.current = current;
          setDetail(current);
        }
        // Restore the within-phase review state from the durable workflow log, so reopening a task
        // whose review already PASSED shows "advance to next phase" instead of re-running review.
        setReviewPassed(lastReviewPassedFromEvents(current.workflowEvents));
        if (!opts?.skipBriefing && isBoardSession(current)) {
          void sendCatchUpBriefing(current, panesFromSession(current, config), config, undefined, Boolean(opts?.forceBriefing));
        }
      }
      setHandoff(null);
    });
  }

  // NOT STARTED task: one click both activates the session AND kicks off Refinement — no separate
  // catch-up briefing (we skip it; goToPhase("plan") boots A1 and sends the analysis instruction).
  async function startRefinement(target: SessionDetail) {
    const synced = await syncBoardBeforeFirstAgentStart(target);
    await activateSessionWithCatchup(synced, { skipBriefing: true });
    const current = detailRef.current?.session.id === synced.session.id ? detailRef.current : synced;
    detailRef.current = current;
    const cfg = configRef.current ?? config;
    if (cfg) {
      const targetPanes = panesFromSession(current, cfg);
      panesRef.current = targetPanes;
      setPanes(targetPanes);
    }
    await goToPhase("plan");
  }

  async function openSession(id: string, openedFrom: SessionPreviewModalState["openedFrom"] = "session-list") {
    const epoch = ++previewEpochRef.current;
    await run(async () => {
      const loaded = await unwrap(window.tandem.sessions.get(id));
      if (previewEpochRef.current !== epoch) return;
      if (!loaded) {
        setErrorNotice("Session not found.");
        return;
      }
      if (await isA1LiveOnSession(loaded)) {
        setDetail(loaded);
        setSessionPreviewModal(null);
        return;
      }
      setSessionPreviewModal({ detail: loaded, openedFrom });
    });
  }

  async function updatePreviewBoardStatus(target: SessionDetail, slot: BoardStatusSlot) {
    const cfg = configRef.current ?? config;
    const workspace = cfg ? activeWorkspace(cfg, target.session.workspaceName) : undefined;
    const status = boardStatusForSlot(slot, workspace);
    await run(async () => {
      const result = await unwrap(window.tandem.board.updateStatus(target.session.id, status, slot));
      const refreshed = result.session;
      setWorkflowWarnings(result.warnings);
      setSessions(await unwrap(window.tandem.sessions.list()));
      setSessionPreviewModal((current) => current?.detail.session.id === target.session.id ? { ...current, detail: refreshed } : current);
      if (detailRef.current?.session.id === target.session.id) {
        detailRef.current = refreshed;
        setDetail(refreshed);
      }
      if (result.warnings.length > 0) {
        setErrorNotice(result.warnings[0]);
      } else {
        setNotice(`Board status changed to ${status}`);
      }
    });
  }

  // Full reset to the first-launch state: both agent CLIs stopped, no active session, no
  // leftover loop state. The session list itself is untouched — reopening restores via catch-up.
  async function clearActiveWorkContext(noticeText: string) {
    sessionEpochRef.current += 1;
    awaitingSide.current = null;
    pendingRollbackStatusRef.current = null;
    reviewRoundRef.current = 0;
    streamBuffers.current = { L: "", R: "" };
    setPendingHandoff(null);
    setReviewPassed(false);
    setHandoff(null);
    setSwitchingAgent(null);
    await resetAgents();
    await unwrap(window.tandem.sessions.setActive(null));
    setDetail(null);
    const configNow = configRef.current;
    if (configNow) setPanes(panesFromConfig(configNow));
    setNotice(noticeText);
  }

  async function exitAllSessions() {
    await run(async () => {
      await clearActiveWorkContext("All agent sessions stopped — clean start.");
    });
  }

  // Read-only mirror of the board, in-app. Fetches the Project's artifacts and groups them by
  // status so the user doesn't have to switch to GitHub/Jira/Linear to see the columns.
  async function openBoardModal() {
    const ws = config ? activeWorkspace(config, activeSession?.workspaceName) : undefined;
    const provider = boardProviderForWorkspace(config, ws);
    if (provider === "none") {
      setErrorNotice("No board is configured for this project — set it in Settings → Board.");
      return;
    }
    if (provider === "github_project" && (!ws?.githubOwner || !ws.projectNumber)) {
      setErrorNotice("No GitHub Project is configured for this project — set it in Settings → Board.");
      return;
    }
    if (provider === "jira" && (!ws?.jiraSiteUrl || !ws.jiraProjectKey)) {
      setErrorNotice("No Jira board is configured for this project — set it in Settings → Board.");
      return;
    }
    setBoardModalOpen(true);
    await refreshBoardModal();
  }

  async function refreshBoardModal() {
    const ws = config ? activeWorkspace(config, activeSession?.workspaceName) : undefined;
    if (!ws) return;
    setBoardLoading(true);
    setBoardError(null);
    try {
      const artifacts = await unwrap(window.tandem.board.listWorkspaceArtifacts(ws.name));
      setBoardArtifacts(artifacts);
      setBoardSyncedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch (error) {
      setBoardError(error instanceof Error ? error.message : String(error));
    } finally {
      setBoardLoading(false);
    }
  }

  // Click a board card → open its Twindem session if one exists, otherwise create one from the
  // issue (the catch-up briefing then summarizes where it stands).
  async function openBoardArtifact(artifact: BoardArtifactOption) {
    setBoardModalOpen(false);
    setOpeningArtifact(boardArtifactRef(artifact));
    try {
      const existing = sessions.find(
        (candidate) =>
          (artifact.repo && artifact.issueNumber && candidate.repo === artifact.repo && candidate.issueNumber === artifact.issueNumber) ||
          (artifact.id && candidate.boardItemId === artifact.id)
      );
      if (existing) {
        await openSession(existing.id, "board-card");
        return;
      }
      if (!config) return;
      const workspace = activeWorkspace(config);
      const leftPane = workspacePaneDefault(config, "L", workspace?.name);
      const rightPane = workspacePaneDefault(config, "R", workspace?.name);
      await createSession({
        title: artifact.title,
        artifactType: "issue",
        workspaceName: workspace?.name ?? config.defaults.workspaceName,
        repo: artifact.repo,
        issueNumber: artifact.issueNumber,
        boardProvider: artifact.provider,
        boardItemId: artifact.id,
        boardItemKey: artifact.key ?? boardArtifactRef(artifact),
        boardItemUrl: artifact.url,
        issueBody: artifact.body ?? "",
        leftRole: leftPane.role,
        leftProvider: leftPane.provider,
        rightRole: rightPane.role,
        rightProvider: rightPane.provider
      });
    } finally {
      setOpeningArtifact(null);
    }
  }

  // A quick note shouldn't make the user pick a repo. Use the one they typed, else the repo of the
  // most recent session, else the board's home repo (prefer a "devops"-like repo), else the first.
  async function resolveQuickNoteRepo(input: CreateSessionInput): Promise<string | null> {
    if (input.repo?.trim()) return input.repo.trim();
    const recent = sessions.find((session) => session.repo)?.repo;
    if (recent) return recent;
    const ws = config ? activeWorkspace(config, input.workspaceName) : undefined;
    if (ws?.root) {
      const repos = await unwrap(window.tandem.board.listWorkspaceRepos(ws.root)).catch(() => []);
      if (repos.length > 0) {
        return (repos.find((repo) => /devops/i.test(repo.fullName)) ?? repos[0]).fullName;
      }
    }
    return null;
  }

  // Quick-capture: a short note goes straight onto the board with a [Short] tag, then Agent 1
  // introduces it and asks whether to discuss — no full idea/bug form.
  async function createQuickNoteSession(input: CreateSessionInput) {
    if (!config) return;
    const repo = await resolveQuickNoteRepo(input);
    sessionEpochRef.current += 1;
    streamBuffers.current = { L: "", R: "" };
    setNewSessionOpen(false);
    setOpeningArtifact("the quick note");
    try {
      await run(async () => {
        await resetAgents();
        const created = await unwrap(window.tandem.sessions.create({ ...input, artifactType: "idea" }));
        await unwrap(window.tandem.sessions.setActive(created.session.id));
        const selectedAutomation = normalizeAutomation(input.automationLevel ?? "auto");
        await unwrap(window.tandem.conductor.update(created.session.id, { automationLevel: selectedAutomation }));
        setAutomationLevel(selectedAutomation);
        // Put it on the board immediately with the [Short] title and the idea-type label.
        const updated = await unwrap(
          window.tandem.board.createTask(created.session.id, {
            repo: repo ?? undefined,
            title: input.title,
            body: input.issueBody?.trim() || "(quick note — to be fleshed out)",
            labels: labelsForIdeaType(created.session.ideaType)
          })
        );
        setDetail(updated);
        detailRef.current = updated;
        setSessions(await unwrap(window.tandem.sessions.list()));
        const configNow = configRef.current ?? config;
        const createdPanes = panesFromSession(updated, configNow);
        setPanes(createdPanes);
        void submitInstruction("L", quickNoteIntroInstruction(updated, input.issueBody?.trim() || ""));
        setNotice(`Quick note on the board: ${boardArtifactRefForSession(updated.session)}.`);
      });
    } finally {
      setOpeningArtifact(null);
    }
  }

  async function createSession(input: CreateSessionInput) {
    if (input.quickNote) {
      await createQuickNoteSession(input);
      return;
    }
    if (input.localOnly) {
      await run(async () => {
        const created = await unwrap(window.tandem.sessions.create(input));
        setSessions(await unwrap(window.tandem.sessions.list()));
        setNewSessionOpen(false);
        setNotice(`Added to sessions list: ${created.session.title}`);
      });
      return;
    }
    // ONE session per board issue: picking an issue that already has a session opens that session
    // (after refreshing its local GitHub cache) instead of creating a clone with a parallel history.
    if ((input.repo && input.issueNumber) || input.boardItemId) {
      const list = await unwrap(window.tandem.sessions.list()).catch(() => sessions);
      const existing = list.find(
        (candidate) =>
          (input.repo && input.issueNumber && candidate.repo === input.repo && candidate.issueNumber === input.issueNumber) ||
          (input.boardItemId && candidate.boardItemId === input.boardItemId)
      );
      if (existing) {
        setNewSessionOpen(false);
        await window.tandem.board.syncArtifact(existing.id).catch(() => undefined);
        setNotice(`${input.boardItemKey ?? `${input.repo}#${input.issueNumber}`} already has a session — opening it.`);
        await openSession(existing.id);
        return;
      }
    }
    sessionEpochRef.current += 1;
    streamBuffers.current = { L: "", R: "" };
    await run(async () => {
      // Fresh agents for the new session — no conversation carried over from a previous one.
      await resetAgents();
      const created = await unwrap(window.tandem.sessions.create(input));
      setSessions(await unwrap(window.tandem.sessions.list()));
      setDetail(created);
      detailRef.current = created;
      await unwrap(window.tandem.sessions.setActive(created.session.id));
      const selectedAutomation = normalizeAutomation(input.automationLevel ?? "auto");
      await unwrap(window.tandem.conductor.update(created.session.id, { automationLevel: selectedAutomation }));
      setAutomationLevel(selectedAutomation);
      if (config) {
        const createdPanes = panesFromSession(created, config);
        setPanes(createdPanes);
        if ((created.session.repo && created.session.issueNumber) || created.session.boardItemId) {
          // Board-issue session: A1 only SUMMARIZES where the task stands (status-aware catch-up)
          // and then waits for the human — never the idea-shaping briefing for an existing task.
          void sendCatchUpBriefing(created, createdPanes, config, input.issueBody?.trim() || undefined);
          void ensureBoardStatusDefault(created);
        } else {
          void sendInitialBriefing(created, createdPanes, config);
        }
      }
      setNewSessionOpen(false);
      setNotice("Session created");
    });
  }

  async function sendInitialBriefing(
    targetDetail: SessionDetail,
    targetPanes: Record<AgentSide, PaneState>,
    targetConfig: TandemConfig
  ) {
    const workspace = activeWorkspace(targetConfig, targetDetail.session.workspaceName);
    const briefing = initialAnalysisBriefing(targetDetail, workspace);
    if (!briefing) return;
    const epoch = sessionEpochRef.current;
    const stale = () => sessionEpochRef.current !== epoch;
    window.setTimeout(() => {
      if (stale()) return;
      void run(async () => {
        await ensureAgentProcess("L", targetDetail, targetPanes, targetConfig);
        if (stale()) return;
        const canSend = await waitForAgentNotBlockedByTrust("L");
        if (!canSend) {
          setErrorNotice("Agent 1 is waiting for folder trust approval. Approve it in the terminal, then start/resend the briefing.");
          return;
        }
        await submitToAgentWithRetry("L", briefing, targetDetail, targetPanes, targetConfig);
        if (stale()) return;
        const updated = await unwrap(window.tandem.sessions.get(targetDetail.session.id));
        if (stale()) return;
        setDetail(updated);
        setNotice("Initial brief sent to Agent 1");
      });
    }, 1300);
  }

  // When an existing session with a board task is opened, start a FRESH Agent 1 and have it read
  // the issue and summarize where we left off, so the normal flow (review / move phase) can resume.
  async function sendCatchUpBriefing(
    targetDetail: SessionDetail,
    targetPanes: Record<AgentSide, PaneState>,
    targetConfig: TandemConfig,
    userNote?: string,
    force = false
  ) {
    if (!isBoardSession(targetDetail)) return;
    // Zero-cost defer: for a session Twindem drove (known status), do NOT interrogate the agent on
    // reopen. Boot Agent 1 idle and stage a one-shot orientation that rides the first real work
    // instruction. `force` (the explicit "Re-sync from board" action) bypasses this.
    if (!force && !userNote && isTwindemOwnedKnownSession(targetDetail)) {
      resumeOrientationPending.current = targetDetail.session.id;
      void run(async () => {
        await ensureAgentProcess("L", targetDetail, targetPanes, targetConfig);
        setNotice("Agent 1 ready — Twindem already knows the status; no catch-up tokens spent. Pick a step to continue.");
      });
      return;
    }
    if (catchUpInFlight.current === targetDetail.session.id) return;
    catchUpInFlight.current = targetDetail.session.id;
    const workspace = activeWorkspace(targetConfig, targetDetail.session.workspaceName);
    const brief = userNote
      ? `${catchUpInstruction(targetDetail, workspace)}\n\nNote from the user (extra context, not an instruction to act yet):\n${userNote}`
      : catchUpInstruction(targetDetail, workspace);
    const epoch = sessionEpochRef.current;
    const stale = () => sessionEpochRef.current !== epoch;
    void run(async () => {
      try {
        if (await unwrap(window.tandem.agents.isRunning("L"))) {
          if (stale()) return;
          await unwrap(window.tandem.agents.stop("L"));
          await wait(900);
        }
        if (stale()) return;
        await startAgentProcess("L", targetDetail, targetPanes, targetConfig);
        await waitForAgentInputReady("L");
        const canSend = await waitForAgentNotBlockedByTrust("L");
        if (!canSend) return;
        // The user switched sessions while Agent 1 was booting — this brief belongs to the OLD
        // session and must not be pasted into the agent the user is now using.
        if (stale()) return;
        suppressMarkers("L", 12000);
        await unwrap(window.tandem.composer.send({ sessionId: targetDetail.session.id, target: "L", text: brief, muteOther: true }));
        for (const delay of [1000, 1500, 1800]) {
          await wait(delay);
          if (stale()) return;
          await window.tandem.agents.write("L", "\r").catch(() => undefined);
        }
        setNotice("Agent 1 is catching up on the task…");
      } finally {
        catchUpInFlight.current = null;
      }
    });
  }

  // Explicit staleness escape hatch (provider-neutral): refresh the artifact (GitHub issue OR Jira
  // item), then force a full catch-up so the agent re-assesses against any change made outside Twindem.
  // This is the ONLY place the interrogation cost is paid deliberately on an owned-known session.
  async function resyncFromBoard() {
    const current = detailRef.current ?? detail;
    if (!current || !config) return;
    await run(async () => {
      try {
        await window.tandem.board.syncArtifact(current.session.id);
      } catch {
        /* best-effort — still re-brief from what we have */
      }
      const refreshed = await window.tandem.sessions
        .get(current.session.id)
        .then((r) => (r.ok ? r.data : null))
        .catch(() => null);
      const synced = refreshed ?? current;
      setDetail(synced);
      setReviewPassed(lastReviewPassedFromEvents(synced.workflowEvents));
      void sendCatchUpBriefing(synced, panesFromSession(synced, config), config, undefined, true);
      setNotice("Re-syncing from the board — Agent 1 will re-assess the current state.");
    });
  }

  async function ensureAgentProcess(
    side: AgentSide,
    targetDetail: SessionDetail,
    targetPanes: Record<AgentSide, PaneState>,
    targetConfig: TandemConfig
  ) {
    const running = await unwrap(window.tandem.agents.isRunning(side));
    const runningSessionId = running ? await unwrap(window.tandem.agents.runningSession(side)) : undefined;
    if (!running || runningSessionId !== targetDetail.session.id) {
      await startAgentProcess(side, targetDetail, targetPanes, targetConfig);
      await wait(250);
    }
  }

  // Fresh start for both agents — used when creating a new session so neither agent carries over
  // the previous session's conversation (a per-session "/clear").
  async function resetAgents() {
    for (const side of ["L", "R"] as const) {
      if (await unwrap(window.tandem.agents.isRunning(side))) {
        await unwrap(window.tandem.agents.stop(side));
      }
    }
    await wait(500);
  }

  // Wait until a freshly-started CLI is ready for input: first output (banner) + a settle window
  // for the boot notices to finish. Avoids sending instructions that get eaten during boot.
  async function waitForAgentInputReady(side: AgentSide) {
    await new Promise<void>((resolve) => {
      agentReadyResolvers.current[side] = resolve;
      window.setTimeout(resolve, 12000);
    });
    await wait(3200);
  }

  async function waitForFolderTrustApproval(side: AgentSide): Promise<boolean> {
    if (folderTrustResolver.current) return false;
    setSwitchingAgent(null);
    setFolderTrustModal({ side });
    setNotice(`${side === "L" ? "Agent 1" : "Agent 2"} is waiting for folder trust approval.`);
    const approved = await new Promise<boolean>((resolve) => {
      folderTrustResolver.current = resolve;
    });
    folderTrustResolver.current = null;
    setFolderTrustModal(null);
    if (approved) {
      // Drop the old prompt text from the tail buffer so trust detection reflects fresh output.
      streamBuffers.current[side] = "";
      await wait(900);
    }
    return approved;
  }

  async function waitForAgentNotBlockedByTrust(side: AgentSide): Promise<boolean> {
    for (const delay of [0, 1200, 1600, 2200, 3000]) {
      if (delay > 0) await wait(delay);
      if (parseTrustPrompt(streamBuffers.current[side])) {
        const approved = await waitForFolderTrustApproval(side);
        if (!approved) return false;
        await waitForAgentInputReady(side);
        return true;
      }
    }
    return true;
  }

  async function submitToAgentWithRetry(
    side: AgentSide,
    text: string,
    targetDetail: SessionDetail,
    targetPanes: Record<AgentSide, PaneState>,
    targetConfig: TandemConfig
  ) {
    suppressMarkers(side, 12000);
    try {
      await unwrap(
        window.tandem.composer.send({
          sessionId: targetDetail.session.id,
          target: side,
          text,
          muteOther: true
        })
      );
    } catch (error) {
      if (!isNoRunningAgentError(error)) throw error;
      await startAgentProcess(side, targetDetail, targetPanes, targetConfig);
      const canSend = await waitForAgentNotBlockedByTrust(side);
      if (!canSend) {
        throw new Error("Agent is waiting for folder trust approval. Approve it in the terminal, then resend the briefing.", { cause: error });
      }
      await wait(350);
      await unwrap(
        window.tandem.composer.send({
          sessionId: targetDetail.session.id,
          target: side,
          text,
          muteOther: true
        })
      );
    }
    // The agent CLI can take several seconds to boot (banner, update notices, setup warnings),
    // so a single Enter gets eaten and the pasted prompt sits unsubmitted. Re-press Enter a few
    // times across the boot window — extra Enters on an empty prompt are harmless no-ops, and one
    // lands once the input is actually ready.
    for (const delay of [900, 1600, 1800]) {
      await wait(delay);
      await window.tandem.agents.write(side, "\r").catch(() => undefined);
    }
  }


  async function startAgent(side: AgentSide) {
    if (!detail) {
      setErrorNotice("Create or select a session before starting an agent.");
      setNewSessionOpen(true);
      return;
    }
    let target = detail;
    if (side === "L") {
      target = await syncBoardBeforeFirstAgentStart(detail);
    }
    await run(() => startAgentProcess(side, target, panes, config));
    sendContextBriefAfterStart(side, { force: true });
  }

  // Restart the agent FRESH and re-seed it from the compact handoff (orientation pack +
  // preserve-filtered evidence trail) instead of resuming the bloated CLI conversation. This is
  // the token-economy escape hatch for long sessions; it is always human-triggered (signal only).
  async function restartAgentWithHandoff(side: AgentSide) {
    const current = detailRef.current ?? detail;
    if (!current) return;
    await run(async () => {
      if (await unwrap(window.tandem.agents.isRunning(side))) {
        await unwrap(window.tandem.agents.stop(side));
        await wait(900);
      }
      await startAgentProcess(side, current, panesRef.current, configRef.current);
      await waitForAgentInputReady(side);
      const detailNow = detailRef.current ?? current;
      if (detailNow.session.id !== current.session.id) return;
      const workspace = configRef.current ? activeWorkspace(configRef.current, detailNow.session.workspaceName) : undefined;
      const pack = buildAgentContextPack({ detail: detailNow, workspace, side, mode: "orientation" });
      const handoff = renderCompactRestartHandoff(pack, detailNow.evidenceRecords ?? []);
      suppressMarkers(side, 12000);
      await unwrap(window.tandem.composer.send({ sessionId: current.session.id, target: side, text: handoff, muteOther: true }));
      for (const delay of [900, 1500, 1800]) {
        await wait(delay);
        await window.tandem.agents.write(side, "\r").catch(() => undefined);
      }
      await window.tandem.evidence
        .addRecord({
          sessionId: current.session.id,
          phase: detailNow.session.visiblePhase,
          kind: "note",
          title: `${side === "L" ? "Agent 1" : "Agent 2"} restarted with compact handoff`,
          summary: "The agent was restarted fresh and re-seeded from the compact handoff (orientation context + preserved decision trail) to keep context volume low.",
          source: "human",
          agentSide: side
        })
        .catch(() => undefined);
      setNotice(`${side === "L" ? "Agent 1" : "Agent 2"} restarted with a compact handoff`);
    });
  }

  async function resumeAgent(side: AgentSide) {
    if (!detail) {
      setErrorNotice("Create or select a session before resuming an agent.");
      setNewSessionOpen(true);
      return;
    }
    if (!canResumeAgent(detail, side)) {
      setErrorNotice("This task has no saved agent conversation to resume. Use Start so Twindem sends the current task context.");
      return;
    }
    await run(() => startAgentProcess(side, detail, panes, config, true));
    sendContextBriefAfterStart(side, { force: true });
  }

  function sendContextBriefAfterStart(side: AgentSide, opts?: { force?: boolean }) {
    const currentDetail = detailRef.current;
    if (!currentDetail) return;
    // Zero-cost defer: an owned-known session needs no orientation interrogation on Start/Resume — the
    // first real work instruction carries a one-shot orientation instead.
    if (!opts?.force && isTwindemOwnedKnownSession(currentDetail)) {
      resumeOrientationPending.current = currentDetail.session.id;
      return;
    }

    const readyPromise = new Promise<void>((resolve) => {
      agentReadyResolvers.current[side] = resolve;
      setTimeout(resolve, 3000);
    });

    void readyPromise.then(async () => {
      await wait(500);
      const detailNow = detailRef.current;
      if (!detailNow || detailNow.session.id !== currentDetail.session.id) return;
      const workspace = config ? activeWorkspace(config, detailNow.session.workspaceName) : undefined;
      const brief = buildSessionContextBrief(detailNow, side, workspace);
      if (!brief) return;
      try {
        const canSend = await waitForAgentNotBlockedByTrust(side);
        if (!canSend || detailRef.current?.session.id !== detailNow.session.id) return;
        await unwrap(window.tandem.composer.send({
          sessionId: detailNow.session.id,
          target: side,
          text: brief,
          muteOther: true
        }));
        // The single Enter from agents.submit can be eaten while the CLI is still booting —
        // re-press across the boot window so the brief actually submits.
        for (const delay of [900, 1500, 1800]) {
          await wait(delay);
          if (detailRef.current?.session.id !== detailNow.session.id) return;
          await window.tandem.agents.write(side, "\r").catch(() => undefined);
        }
      } catch { /* agent not ready */ }
    });
  }

  async function startAgentProcess(
    side: AgentSide,
    targetDetail = detail,
    targetPanes = panes,
    targetConfig = config,
    resume = false
  ) {
    if (!targetDetail) throw new Error("Create or select a session before starting an agent.");
    const pane = targetPanes[side];
    const provider = targetConfig?.providers[pane.provider] ?? targetConfig?.providers.shell;
    const workspaceRoot = targetConfig ? activeWorkspace(targetConfig, targetDetail.session.workspaceName)?.root : undefined;
    const previousRun = latestRunForSide(targetDetail, side);
    const nativeSessionId = previousRun?.nativeSessionId;
    const nativeSessionName = previousRun?.nativeSessionName || `twindem-${targetDetail.session.id}-${side}`;
    const launch = resolveAgentLaunch(provider, resume, targetDetail.session.dangerouslySkipPermissions);
    const { command, args } = launch;
    if (!command?.trim()) {
      throw new Error(`No command configured for side ${side}. Open Setup or Settings and choose an agent CLI.`);
    }
    if (!workspaceRoot?.trim()) {
      throw new Error("No working directory configured. Open Setup and choose the project/application folder.");
    }
    const commandCheck = await unwrap(window.tandem.system.checkCommand(command));
    if (!commandCheck.ok) throw new Error(commandCheck.message);
    setNotice(`${resume ? "Resuming" : "Starting"} ${providerDisplay(provider)} on side ${side}...`);
    await unwrap(
      window.tandem.agents.start(
        side,
        command,
        args,
        workspaceRoot,
        targetDetail.session.id,
        roleLabel(pane.roles),
        pane.provider,
        nativeSessionId,
        nativeSessionName,
        launch.resumeCommand,
        launch.resumeArgs
      )
    );
    const updated = await unwrap(
      window.tandem.conductor.update(targetDetail.session.id, {
        activeSide: side,
        restorePending: false
      })
    );
    // If the user switched sessions while the agent was starting, don't clobber the visible
    // session's detail with the one this start was for.
    if (detailRef.current?.session.id === targetDetail.session.id) {
      setDetail(updated);
    }
    setPanes((prev) => ({ ...prev, [side]: { ...prev[side], status: "running" } }));
  }

  async function handleInvalidResume(side: AgentSide, output: string) {
    const detailNow = detailRef.current;
    const configNow = configRef.current;
    if (!detailNow) return;
    const key = `${detailNow.session.id}:${side}:invalid-resume`;
    if (handledMarkers.current.has(key)) return;
    handledMarkers.current.add(key);
    await reportErrors(async () => {
      await unwrap(window.tandem.agents.clearResume(detailNow.session.id, side));
      appendAgentCard({
        id: `${key}:${Date.now()}`,
        sessionId: detailNow.session.id,
        side,
        kind: "result",
        title: "Resume unavailable — restarting fresh",
        body: `${output.replace(/\s+/g, " ").trim()} Restarting with --continue.`,
        createdAt: new Date().toISOString()
      });
      await unwrap(window.tandem.agents.stop(side));
      await wait(300);
      const refreshed = await unwrap(window.tandem.sessions.get(detailNow.session.id));
      if (refreshed && configNow) {
        setDetail(refreshed);
        const refreshedPanes = panesFromSession(refreshed, configNow);
        setPanes(refreshedPanes);
        await startAgentProcess(side, refreshed, refreshedPanes, configNow, false);
      }
      setNotice(`${side === "L" ? "Agent 1" : "Agent 2"} resume failed — restarted fresh.`);
    }, setErrorNotice);
  }

  async function stopAgent(side: AgentSide) {
    await run(async () => {
      await unwrap(window.tandem.agents.stop(side));
      setPanes((prev) => ({ ...prev, [side]: { ...prev[side], status: "idle" } }));
    });
  }

  async function updatePane(side: AgentSide, patch: Partial<PaneState>) {
    const allRoles = Object.keys(config?.roles ?? {});
    const rolePatch = patch.roles && allRoles.length > 0
      ? partitionRolesForSide(side, patch.roles, panes.L.roles, panes.R.roles, allRoles)
      : null;
    const nextPanes = rolePatch
      ? {
          ...panes,
          L: { ...panes.L, roles: rolePatch.L },
          R: { ...panes.R, roles: rolePatch.R },
          [side]: { ...panes[side], ...patch, roles: rolePatch[side] }
        }
      : { ...panes, [side]: { ...panes[side], ...patch } };
    setPanes(nextPanes);

    if (patch.provider && panes[side].status === "running" && detail && config) {
      const label = side === "L" ? "Agent 1" : "Agent 2";
      const oldCommand = config.providers[panes[side].provider]?.command?.trim();
      const newProvider = config.providers[patch.provider];
      // Same CLI (just a different model/version) → resume its OWN conversation natively, keeping
      // context. Different CLI → no native transfer possible; rehydrate from the durable context
      // (the board for tasks, the idea body file for local ideas).
      const sameCli = Boolean(oldCommand && newProvider?.command?.trim() && oldCommand === newProvider.command.trim());
      const canResume = sameCli && canResumeAgent(detail, side);
      await run(async () => {
        await unwrap(window.tandem.agents.stop(side));
        await startAgentProcess(side, detail, nextPanes, config, canResume);
        if (canResume) {
          setNotice(`${label} switched to ${providerDisplay(newProvider)} — conversation kept (resumed).`);
        } else {
          setNotice(`${label} switched to ${providerDisplay(newProvider)} — different CLI, rehydrating context.`);
          sendContextBriefAfterStart(side);
        }
      });
    }
  }

  // Abort an in-flight switch so the user can keep working with the agent that just finished.
  function cancelSwitch() {
    switchCancelRef.current = true;
    awaitingSide.current = null;
    handoffBusy.current = false;
    setSwitchingAgent(null);
    setNotice("Switch cancelled — keep working with the current agent, then hand off when ready.");
  }

  async function updateAutomationLevel(level: AutomationLevel) {
    setAutomationLevel(level);
    if (!detail) return;
    await run(async () => {
      const updated = await unwrap(window.tandem.conductor.update(detail.session.id, { automationLevel: level }));
      setDetail(updated);
    });
  }

  async function approveHandoff() {
    if (!handoff || !detail) return;
    await run(async () => {
      await unwrap(window.tandem.handoffs.approve(handoff.id));
      if (handoff.toSide) {
        await unwrap(window.tandem.conductor.update(detail.session.id, { activeSide: handoff.toSide, restorePending: false }));
      }
      setHandoff(null);
      setDetail(await unwrap(window.tandem.sessions.get(detail.session.id)));
      setNotice("Briefing approved and sent");
    });
  }


  async function confirmWorkflowAction() {
    if (!detail || !workflowModal) return;
    await run(async () => {
      const result =
        workflowModal.verdict === "requested"
          ? await unwrap(window.tandem.workflow.requestTaskReview(detail.session.id, workflowModal.body))
          : await unwrap(
              window.tandem.workflow.applyTaskReviewVerdict(
                detail.session.id,
                workflowModal.verdict,
                workflowModal.body
              )
            );
      applyWorkflowResult(result);
      setSessions(await unwrap(window.tandem.sessions.list()));
      setWorkflowModal(null);
      setNotice(workflowModal.verdict === "requested" ? "Task review requested on the board" : "Task review posted");
    });
  }

  function applyWorkflowResult(result: WorkflowActionResult) {
    detailRef.current = result.session;
    setDetail(result.session);
    setWorkflowWarnings(result.warnings);
  }

  async function syncGithub() {
    if (!detail) return;
    await run(async () => {
      await unwrap(window.tandem.board.syncArtifact(detail.session.id));
      setDetail(await unwrap(window.tandem.sessions.get(detail.session.id)));
      setSessions(await unwrap(window.tandem.sessions.list()));
      setNotice("GitHub issue synced");
    });
  }

  async function attachIssue(ref: string, continueToReview: boolean) {
    if (!detail) return;
    await run(async () => {
      const parsed = parseIssueRef(ref);
      if (!parsed) throw new Error("Use a GitHub issue URL or owner/repo#123.");
      const updated = await unwrap(window.tandem.board.attachArtifact(detail.session.id, parsed.repo, parsed.issueNumber));
      setDetail(updated);
      setSessions(await unwrap(window.tandem.sessions.list()));
      setAttachIssueModal(null);
      setNotice(`Attached ${parsed.repo}#${parsed.issueNumber}`);
      if (continueToReview) {
        await startReviewHandoff(updated);
      }
    });
  }


  async function recoverIssueLinksFromSessions(sessionSummaries: SessionSummary[]) {
    for (const summary of sessionSummaries.slice(0, 25)) {
      if (!summary.id) continue;
      const source = await unwrap(window.tandem.sessions.get(summary.id));
      if (!source) continue;
      const refs = parseIssueRefsFromText(source.transcript.map((event) => event.content).join("\n"));
      for (const parsed of refs) {
        const key = `recovered:${source.session.id}:${parsed.repo}#${parsed.issueNumber}`;
        if (handledIssueLinks.current.has(key)) continue;
        handledIssueLinks.current.add(key);

        const currentIssueKey = source.session.repo && source.session.issueNumber
          ? `${source.session.repo}#${source.session.issueNumber}`
          : null;
        const detectedIssueKey = `${parsed.repo}#${parsed.issueNumber}`;
        if (!currentIssueKey) continue;
        if (currentIssueKey === detectedIssueKey) continue;

        await reportErrors(async () => {
          await unwrap(window.tandem.board.createSessionFromArtifact(source.session.id, parsed.repo, parsed.issueNumber));
          setSessions(await unwrap(window.tandem.sessions.list()));
        }, setErrorNotice);
      }
    }
  }

  async function updateSessionDetails(input: UpdateSessionInput) {
    await run(async () => {
      const updated = await unwrap(window.tandem.sessions.update(input));
      setDetail(updated);
      setSessions(await unwrap(window.tandem.sessions.list()));
      setSessionEditModal(null);
      setNotice("Session updated");
    });
  }

  async function deleteSession(id: string) {
    const session = sessions.find((candidate) => candidate.id === id);
    setSessionMenuOpen(null);
    if (session) {
      setDeleteSessionModal({
        id,
        title: session.title,
        repo: session.repo,
        issueNumber: session.issueNumber,
        boardProvider: session.boardProvider,
        boardItemId: session.boardItemId,
        boardItemKey: session.boardItemKey,
        deleteBoardArtifact: false
      });
    }
  }

  async function confirmDeleteSession() {
    if (!deleteSessionModal || deletingSession) return;
    const { id, deleteBoardArtifact } = deleteSessionModal;
    setDeletingSession(true);
    try {
      await run(async () => {
        const remoteNotice = await unwrap(window.tandem.sessions.delete(id, { deleteBoardArtifact }));
        const nextSessions = await unwrap(window.tandem.sessions.list());
        setSessions(nextSessions);
        // Don't auto-select another session — leave the empty state with nothing selected.
        if (detail?.session.id === id) {
          setDetail(null);
          await unwrap(window.tandem.sessions.setActive(null));
        }
        setDeleteSessionModal(null);
        setNotice(
          remoteNotice ||
            (deleteBoardArtifact ? "Session deleted and remote board task closed" : "Session deleted locally")
        );
      });
    } finally {
      setDeletingSession(false);
    }
  }

  async function downloadSession(id: string) {
    setSessionMenuOpen(null);
    await run(async () => {
      const path = await unwrap(window.tandem.sessions.download(id));
      if (path) setNotice(`Session downloaded to ${path}`);
    });
  }

  function openSessionEdit(session: SessionSummary) {
    setSessionMenuOpen(null);
    setSessionEditModal({
      id: session.id,
      title: session.title,
      initialBody: session.initialBody ?? "",
      ideaType: ideaTypeDefinition(session.ideaType).key,
      notStarted: taskBadge(session, config ? activeWorkspace(config, session.workspaceName) : undefined).key === "not_started"
    });
  }

  function openSessionEditFromDetail(current: SessionDetail) {
    const workspace = config ? activeWorkspace(config, current.session.workspaceName) : undefined;
    setSessionPreviewModal(null);
    setSessionMenuOpen(null);
    setSessionEditModal({
      id: current.session.id,
      title: current.session.title,
      initialBody: current.session.initialBody ?? "",
      ideaType: ideaTypeDefinition(current.session.ideaType).key,
      notStarted: taskBadge(current.session, workspace).key === "not_started"
    });
  }

  async function syncBoardBeforeFirstAgentStart(current: SessionDetail): Promise<SessionDetail> {
    const hasBoard = hasBoardArtifactSession(current.session);
    if (!hasBoard || taskBadge(current.session, configRef.current ? activeWorkspace(configRef.current, current.session.workspaceName) : undefined).key !== "not_started") return current;
    const synced = await unwrap(window.tandem.sessions.syncNotStartedBoard(current.session.id));
    detailRef.current = synced;
    setDetail(synced);
    setSessions(await unwrap(window.tandem.sessions.list()));
    return synced;
  }

  async function confirmIssueEdit() {
    if (!detail || !issueEditModal) return;
    await run(async () => {
      const updated =
        issueEditModal.mode === "body"
          ? await unwrap(window.tandem.board.updateArtifactBody(detail.session.id, issueEditModal.body))
          : await unwrap(window.tandem.board.commentArtifact(detail.session.id, issueEditModal.body));
      setDetail(updated);
      setSessions(await unwrap(window.tandem.sessions.list()));
      setIssueEditModal(null);
      setNotice(issueEditModal.mode === "body" ? "Issue body updated" : "Issue comment posted");
    });
  }

  async function runDeployAttempt() {
    if (!detail) return;
    await run(async () => {
      const result = await unwrap(window.tandem.workflow.deployUat(detail.session.id));
      applyWorkflowResult(result);
      setSessions(await unwrap(window.tandem.sessions.list()));
      setNotice("UAT deploy command completed");
    });
  }

  async function startReviewHandoff(sourceDetail = detail) {
    if (!sourceDetail) return;
    if (!sourceDetail.session.repo || !sourceDetail.session.issueNumber) {
      setAttachIssueModal({ ref: "", continueToReview: true });
      return;
    }
    await run(async () => {
      const cfg = configRef.current ?? config;
      const targetPanes = cfg ? panesFromSession(sourceDetail, cfg) : panesRef.current;
      panesRef.current = targetPanes;
      // Ask the main process, not pane state — pane state can lag behind a dead/exited agent.
      const rRunning = await unwrap(window.tandem.agents.isRunning("R"));
      const rSessionId = rRunning ? await unwrap(window.tandem.agents.runningSession("R")) : undefined;
      if (!rRunning || rSessionId !== sourceDetail.session.id) {
        await startAgentProcess("R", sourceDetail, targetPanes, cfg);
        await waitForAgentInputReady("R");
      }
      const draft = await unwrap(
        window.tandem.handoffs.createDraft(sourceDetail.session.id, "L", roleLabel(targetPanes.L.roles), "R", roleLabel(targetPanes.R.roles))
      );
      await unwrap(window.tandem.handoffs.approve(draft.id));
      await unwrap(window.tandem.conductor.update(sourceDetail.session.id, { activeSide: "R", restorePending: false }));
      setHandoff(null);
      const updated = await unwrap(window.tandem.sessions.get(sourceDetail.session.id));
      detailRef.current = updated;
      setDetail(updated);
      setNotice("Reviewer started and briefing sent");
    });
  }

  async function sendAgentInstruction(side: AgentSide, text: string) {
    if (!detail) return;
    await unwrap(
      window.tandem.composer.send({
        sessionId: detail.session.id,
        target: side,
        text,
        muteOther: true
      })
    );
    await unwrap(window.tandem.conductor.update(detail.session.id, { activeSide: side, restorePending: false }));
    setDetail(await unwrap(window.tandem.sessions.get(detail.session.id)));
  }

  // Robust instruction send: ensure the agent is running, wait for the CLI to boot, send, then
  // re-press Enter across the boot window so the prompt actually submits.
  // Ignore marker detection for a window after sending, so the echoed prompt text (which contains
  // marker strings) doesn't fire as if the agent emitted it.
  function suppressMarkers(side: AgentSide, ms = 9000) {
    markerSuppressedUntil.current[side] = Math.max(markerSuppressedUntil.current[side], Date.now() + ms);
  }

  async function submitInstruction(side: AgentSide, text: string) {
    const current = detailRef.current;
    if (!current) return;
    // First real instruction after a deferred resume: prepend the one-shot orientation (statement of
    // where the task stands) so the agent has context without a separate catch-up turn. Consumed once.
    let outgoing = text;
    if (resumeOrientationPending.current === current.session.id) {
      resumeOrientationPending.current = null;
      const ws = configRef.current ? activeWorkspace(configRef.current, current.session.workspaceName) : undefined;
      outgoing = `${resumeOrientationBlock(current, ws)}\n${text}`;
    }
    // New turn for this side → forget its handled permission prompts so a fresh prompt re-shows.
    for (const handledKey of Array.from(handledPermissionPrompts.current)) {
      if (handledKey.startsWith(`${side}:`)) handledPermissionPrompts.current.delete(handledKey);
    }
    setTerminalAttention(false);
    switchCancelRef.current = false;
    try {
      const running = await unwrap(window.tandem.agents.isRunning(side));
      const runningSessionId = running ? await unwrap(window.tandem.agents.runningSession(side)) : undefined;
      if (switchCancelRef.current) return;
      if (!running || runningSessionId !== current.session.id) {
        await startAgentProcess(side, current, panesRef.current, configRef.current);
        await waitForAgentInputReady(side);
      } else {
        await wait(300);
      }
      if (switchCancelRef.current) return;
      const canSend = await waitForAgentNotBlockedByTrust(side);
      if (!canSend) {
        throw new Error(`${side === "L" ? "Agent 1" : "Agent 2"} is waiting for folder trust approval. Approve it in the terminal, then resend the instruction.`);
      }
      setSwitchingAgent(side);
      suppressMarkers(side);
      // A leftover signal file from this side's previous turn must not answer the NEW instruction.
      await window.tandem.signals.clear(current.session.id, side).catch(() => undefined);
      if (switchCancelRef.current) return;
      await unwrap(window.tandem.composer.send({ sessionId: current.session.id, target: side, text: outgoing, muteOther: true }));
      for (const delay of [900, 1500, 1800]) {
        await wait(delay);
        if (switchCancelRef.current) return;
        await window.tandem.agents.write(side, "\r").catch(() => undefined);
      }
      await unwrap(window.tandem.conductor.update(current.session.id, { activeSide: side, restorePending: false }));
      setDetail(await unwrap(window.tandem.sessions.get(current.session.id)));
    } finally {
      setSwitchingAgent(null);
    }
  }

  // Serializes button-driven handoffs: a double-click (or a phase click during an in-flight
  // handoff) must not paste two interleaved instructions into the same PTY or double-count rounds.
  const handoffBusy = useRef(false);

  // "Agent name (version)" for attribution footers on issue bodies/comments.
  function agentSignature(side: AgentSide): string {
    const providerKey = panesRef.current[side]?.provider ?? "";
    const provider = configRef.current?.providers[providerKey];
    const model = provider?.model?.split("—")[0]?.trim();
    const suffix = model && !/^(default|CLI default)$/i.test(model) ? ` (${model})` : "";
    return `${provider?.label ?? "AI agent"}${suffix}`;
  }

  // Push Agent 1's latest plan (the body file it keeps updated) into the board task body BEFORE
  // the reviewer reads it — otherwise A2 reviews a stale body and the loop debates thin air.
  const lastAppendedBodyRef = useRef("");
  async function syncTaskBodyFromAgent1(current: SessionDetail): Promise<void> {
    // Works for any board the session lives on — GitHub (repo/issueNumber) OR Jira (boardItemId).
    // The GitHub-only guard here used to silently skip Jira, so A2 always reviewed the stale one-line
    // theme and looped on the same finding forever.
    const hasBoard = isBoardSession(current);
    if (!hasBoard) return;
    try {
      const file = await window.tandem.signals.readIdeaBody(current.session.id, true);
      if (!file.ok || !file.data) return;
      const body = file.data.trim();
      if (!body || body === lastAppendedBodyRef.current) return;
      lastAppendedBodyRef.current = body;
      // REPLACE the body with the single authoritative plan — never append. Appending left the old
      // (rejected) plan next to the corrected one, which made the reviewer loop on "remove the
      // superseded block" forever (issue #46). A1's plan is self-contained.
      const combined = `${body}\n\n_updated by ${agentSignature("L")} via Twindem_`;
      const updated = await unwrap(window.tandem.board.updateArtifactBody(current.session.id, combined));
      if (updated) {
        setDetail(updated);
        detailRef.current = updated;
      }
      // Document A1's side of the loop as a board comment (single source of truth): the corrector
      // updated the body to address the round's review. Best-effort — body update already succeeded.
      const round = reviewRoundRef.current || 1;
      await window.tandem.board
        .commentArtifact(current.session.id, `Round ${round}: updated the task description to address the latest review. — ${agentSignature("L")} via Twindem`)
        .catch(() => undefined);
      setNotice("Task body updated with Agent 1's plan.");
    } catch (error) {
      // Non-fatal: the review can still proceed, but warn — on Jira a failure here means A2 will read
      // the stale body. Surfacing it beats the old silent swallow that hid exactly this bug.
      setErrorNotice(
        `Couldn't push Agent 1's plan to the board (the reviewer may read a stale body): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function runReviewHandoff(sourceDetail: SessionDetail) {
    if (handoffBusy.current) return;
    handoffBusy.current = true;
    try {
      reviewRoundRef.current += 1;
      awaitingSide.current = "R";
      setPendingHandoff(null);
      setReviewPassed(false);
      // The reviewer reads the ISSUE — make sure A1's latest plan is actually on it first.
      await syncTaskBodyFromAgent1(detailRef.current ?? sourceDetail);
      const reviewDetail = detailRef.current ?? sourceDetail;
      const configNow = configRef.current;
      const workspace = configNow ? activeWorkspace(configNow, reviewDetail.session.workspaceName) : undefined;
      // Round N+1 verifies only the addressed findings (delta review protocol).
      const addressed = lastReviewFindingsRef.current.filter((finding) => finding.status === "addressed");
      await submitInstruction(
        "R",
        reviewInstruction(reviewDetail, reviewRoundRef.current, agentSignature("R"), workspace, addressed.length > 0 ? addressed : undefined)
      );
      setNotice(`Review round ${reviewRoundRef.current} sent to Agent 2`);
    } finally {
      handoffBusy.current = false;
    }
  }

  // Safety brake on the auto review↔fix ping-pong: after this many rounds the loop pauses and the
  // human decides whether another round is worth it. Manual button clicks always remain allowed —
  // the cap limits unattended spend, not the human.
  function reviewRoundLimit(detailNow: SessionDetail): number {
    const workflows = configRef.current?.workflows;
    const workflowLimit = workflows ? Object.values(workflows)[0]?.roundLimit : undefined;
    return Math.max(1, detailNow.session.roundTotal || workflowLimit || 3);
  }

  async function autoLoopBudgetExceeded(detailNow: SessionDetail): Promise<string | null> {
    const result = await window.tandem.usage.summary(detailNow.session.id).catch(() => null);
    const summary = result?.ok ? result.data : detailNow.usageSummary;
    if (!summary) return null;
    const heavyAgent = summary.byAgent.find((agent) => agent.side && agent.totalEstimateTokens >= AUTO_LOOP_AGENT_VOLUME_LIMIT);
    if (summary.totalEstimateTokens >= AUTO_LOOP_TOTAL_VOLUME_LIMIT) {
      return `Auto loop paused: this task is already at ~${formatCompactVolume(summary.totalEstimateTokens)} terminal-context volume. Review the output, compact/restart if needed, then continue manually.`;
    }
    if (heavyAgent) {
      return `Auto loop paused: ${heavyAgent.side === "L" ? "Agent 1" : "Agent 2"} is already at ~${formatCompactVolume(heavyAgent.totalEstimateTokens)} terminal-context volume. Use manual handoff or compact restart before another automated turn.`;
    }
    return null;
  }

  // Route a consumed signal file to the same state machine the old markers drove.
  async function handleAgentSignal(signal: AgentSignal, polledSessionId: string) {
    const detailNow = detailRef.current;
    if (!detailNow) return;
    // The user switched sessions between the poll and now — this signal belongs to the OLD
    // session and must not drive handoffs in the one on screen. (Reopening that session restores
    // its flow via the catch-up briefing.)
    if (detailNow.session.id !== polledSessionId) return;
    if (!isBoardSession(detailNow)) {
      // Before a task exists, only Agent 1's idea-shaping signals are meaningful.
      if (signal.side !== "L") return;
      if (signal.phase === "task" || signal.phase === "create") await handleTaskMarker("L");
      else if (signal.phase === "idea" || signal.phase === "ready") await handleDoneMarker("L", { phase: "idea" });
      return;
    }
    // A1's progress assessment for an issue that had no board status.
    if (signal.phase === "status" && signal.side === "L" && signal.status) {
      await applyProposedBoardStatus(signal.status);
      return;
    }
    if (signal.comment?.trim()) {
      await window.tandem.board
        .commentArtifact(detailNow.session.id, [signal.comment.trim(), "", `_updated by ${agentSignature(signal.side)} via Twindem_`].join("\n"))
        .then(() => setNotice(`${signal.side === "L" ? "Agent 1" : "Agent 2"} comment posted to the board.`))
        .catch((error) => setErrorNotice(`Could not post board comment: ${error instanceof Error ? error.message : String(error)}`));
      if (signal.phase === "comment" || signal.phase === "board_comment") return;
    }
    if (signal.phase === "comment" || signal.phase === "board_comment") {
      return;
    }
    // Release Operator finished a deploy → record evidence and advance the board.
    if (signal.phase === "released" && signal.side === "R") {
      await completeProdRelease();
      return;
    }
    if (signal.phase === "deployed" && signal.side === "R") {
      await window.tandem.evidence
        .updateStatus(detailNow.session.id, "deploy_evidence", "done", "UAT deploy completed by the Release Operator")
        .catch(() => undefined);
      await transitionWorkflow("uat");
      setNotice("Agent 2 confirmed the UAT deploy — task moved to UAT ✓");
      return;
    }
    if (signal.phase === "merged" && signal.side === "R") {
      const summary = signal.summary?.trim() || "Release PR merge completed by Agent 2. See the agent transcript for details.";
      if (!signal.comment?.trim()) {
        await window.tandem.board
          .commentArtifact(
            detailNow.session.id,
            [`### Release PR merge`, "", summary, "", `_updated by ${agentSignature("R")} via Twindem_`].join("\n")
          )
          .catch(() => undefined);
      }
      setNotice("Agent 2 confirmed PR merge.");
      return;
    }
    if (signal.phase === "tasks" && signal.side === "L") {
      if (!signal.tasks || signal.tasks.length === 0) {
        setNotice("Agent 1 signaled task proposals, but no parseable tasks were found.");
        return;
      }
      setTaskProposalModal({
        sourceSessionId: detailNow.session.id,
        sourceBoardRef: boardArtifactRefForSession(detailNow.session),
        tasks: signal.tasks.map((task) => ({ ...task, status: "selected" })),
        creating: false
      });
      setNotice(`Agent 1 proposed ${signal.tasks.length} implementation task${signal.tasks.length === 1 ? "" : "s"}.`);
      return;
    }
    await handleDoneMarker(signal.side, { phase: signal.phase, verdict: signal.verdict, findings: signal.findings });
  }

  // Agent 1 signals the idea is shaped enough to become a board task (open questions may remain).
  async function handleTaskMarker(side: AgentSide) {
    const detailNow = detailRef.current;
    if (!detailNow || side !== "L") return;
    const key = `${detailNow.session.id}:task:create`;
    if (handledMarkers.current.has(key)) return;
    handledMarkers.current.add(key);
    if (!isBoardSession(detailNow)) {
      setNotice("Agent 1 proposes creating the task — confirm to put it on the board.");
      setCreateTaskOpen(true);
    }
  }

  async function handleDoneMarker(
    side: AgentSide,
    done: { phase: string; verdict?: ParsedTwindemResult["verdict"]; findings?: ReviewFinding[] }
  ) {
    const detailNow = detailRef.current;
    if (!detailNow) return;
    if (done.phase === "idea") {
      const key = `${detailNow.session.id}:done:idea`;
      if (handledMarkers.current.has(key)) return;
      handledMarkers.current.add(key);
    }

    if (done.phase === "idea") {
      // No issue exists yet — Agent 1 has shaped the idea and written the task body. Proactively
      // open the Create-task dialog so the human just confirms; the analysis becomes the body.
      if (!isBoardSession(detailNow)) {
        setNotice("Agent 1 shaped the idea ✓ — confirm to create the board task.");
        setCreateTaskOpen(true);
        return;
      }
    }

    // Agent 1 finished producing/revising the plan → ready for Agent 2's review.
    // (Accept legacy "analysis"/"implementation" as aliases for "ready".)
    if (done.phase === "ready" || done.phase === "analysis" || done.phase === "implementation") {
      if (side === "R") return; // a verdict-less "ready" should come from Agent 1
      // Already handed to A2 this turn — ignore A1's lingering/redrawn "ready".
      if (awaitingSide.current === "R") return;
      // NOTE: only the auto handoff path claims the turn (inside runReviewHandoff). The manual
      // paths must NOT claim it, or A1's next fresh "ready" (e.g. after resolving Inbox open
      // questions) would be silently dropped by the guard above.
      const workspace = config ? activeWorkspace(config, detailNow.session.workspaceName) : undefined;
      const inInbox = sessionPhaseReached(detailNow, workspace) <= 0;
      const limit = reviewRoundLimit(detailNow);
      // In the idea/Inbox phase we NEVER auto-review (the human resolves open questions first) —
      // just light the cue. Auto-review only kicks in from Refinement onward.
      if (inInbox) {
        const key = `${detailNow.session.id}:ready:inbox`;
        if (handledMarkers.current.has(key)) return;
        handledMarkers.current.add(key);
        // Idea phase is human-gated: there is NO idea-review. Once A1 has shaped the idea, point the
        // human to Refinement (where the technical-plan loop with A2 begins). No "Review → A2".
        awaitingSide.current = null;
        setPendingHandoff(null);
        setReviewPassed(true); // lights the Refinement phase button so the next step stays clear
        // No "continue to next step?" modal — only the human moves the phase. Just light the cue.
        setNotice('Agent 1 shaped the idea ✓ — click Refinement when you want to start the technical plan.');
      } else if (automationLevelRef.current === "auto" && reviewRoundRef.current >= limit) {
        // Round cap reached: pause the auto loop, hand the decision to the human.
        setPendingHandoff("review");
        setNotice(
          `Agent 1 is ready, but the auto loop is paused: ${limit} review round${limit === 1 ? "" : "s"} already ran. Click "Review → A2" if another round is worth it, or advance the phase.`
        );
      } else if (automationLevelRef.current === "auto") {
        const budgetReason = await autoLoopBudgetExceeded(detailRef.current ?? detailNow);
        if (budgetReason) {
          setPendingHandoff("review");
          setNotice(budgetReason);
          return;
        }
        await runReviewHandoff(detailRef.current ?? detailNow);
      } else {
        setPendingHandoff("review");
        setNotice('Agent 1 is ready ✓ — click "Review → A2" to hand off (or advance the phase).');
      }
      return;
    }

    // Agent 2 confirmed the rollback — now apply the destination status the human picked.
    if (done.phase === "rollback" && side === "R") {
      const statusAfter = pendingRollbackStatusRef.current;
      pendingRollbackStatusRef.current = null;
      if (statusAfter) {
        await changeBoardStatus(statusAfter);
        setNotice(`Rollback confirmed — task moved to "${statusAfter}".`);
      } else {
        setNotice("Rollback confirmed by Agent 2.");
      }
      return;
    }

    if (done.phase === "review") {
      if (side !== "R") return; // verdicts come from Agent 2
      // Already handed back to A1 this turn — ignore A2's lingering/redrawn verdict.
      if (awaitingSide.current === "L") return;
      // Post the verdict + findings to the board ourselves on providers where the agent can't write
      // (e.g. Jira — no gh). On GitHub the agent already posts via gh, so we skip to avoid duplicates.
      await postReviewVerdictToBoard(detailNow, done.verdict, done.findings);
      if (done.verdict === "Changes requested") {
        awaitingSide.current = "L";
        setReviewPassed(false);
        const findings = done.findings ?? [];
        lastReviewFindingsRef.current = findings;
        const limit = reviewRoundLimit(detailNow);
        const followUpTasks =
          detailNow.session.ideaType === "architecture" && reviewRoundRef.current >= limit
            ? architectureFindingTasks(findings)
            : [];
        if (followUpTasks.length > 0) {
          awaitingSide.current = null;
          setPendingHandoff(null);
          setTaskProposalModal({
            sourceSessionId: detailNow.session.id,
            sourceBoardRef: boardArtifactRefForSession(detailNow.session),
            tasks: followUpTasks,
            creating: false
          });
          setNotice(
            `Architecture review reached ${reviewRoundRef.current}/${limit} rounds. Converted ${followUpTasks.length} remaining blocking finding${followUpTasks.length === 1 ? "" : "s"} into follow-up task proposals.`
          );
          return;
        }
        if (automationLevelRef.current === "auto" && reviewRoundRef.current >= limit) {
          // Round cap reached: don't auto-send another fix round — the agents may be going in
          // circles. Light the manual cue and let the human read the findings first.
          setPendingHandoff("findings");
          setNotice(
            `Reviewer requested changes in round ${reviewRoundRef.current}, the last auto round (limit ${limit}). Read the findings, then click "Findings → A1" to continue manually — or step in yourself.`
          );
        } else if (automationLevelRef.current === "auto") {
          const budgetReason = await autoLoopBudgetExceeded(detailRef.current ?? detailNow);
          if (budgetReason) {
            setPendingHandoff("findings");
            setNotice(budgetReason);
            return;
          }
          await submitInstruction(
            "L",
            correctionsInstruction(detailRef.current ?? detailNow, reviewRoundRef.current, agentSignature("L"), lastReviewFindingsRef.current)
          );
          lastReviewFindingsRef.current = lastReviewFindingsRef.current.map((finding) => ({ ...finding, status: "addressed" }));
        } else {
          setPendingHandoff("findings");
          setNotice('Reviewer requested changes — click "Findings → A1" to send them back.');
        }
      } else if (done.verdict === "Blocked") {
        awaitingSide.current = null;
        setReviewPassed(false);
        setPendingHandoff(null);
        setNotice("Reviewer blocked this step — needs your attention.");
      } else if (done.verdict === "OK") {
        awaitingSide.current = null;
        setPendingHandoff(null);
        lastReviewFindingsRef.current = [];
        const workspace = config ? activeWorkspace(config, detailNow.session.workspaceName) : undefined;
        const inInbox = sessionPhaseReached(detailNow, workspace) <= 0;
        if (inInbox) {
          const key = `${detailNow.session.id}:review-ok:inbox`;
          if (handledMarkers.current.has(key)) return;
          handledMarkers.current.add(key);
          setReviewPassed(true);
          setNotice("Idea review passed ✓ — click Refinement when you're ready.");
        } else {
          setReviewPassed(true);
          setNotice("Review passed ✓ — advance to the next phase when you're ready.");
        }
      } else {
        // FAIL-CLOSED: a verdict we can't read must never count as a pass. Stop the loop and put
        // the human in charge — they can re-request the verdict or read A2's comments themselves.
        awaitingSide.current = null;
        setReviewPassed(false);
        setPendingHandoff("review");
        setErrorNotice(
          'Agent 2 finished its review but the verdict was unreadable. Check Agent 2\'s last message, or click "Review → A2" to re-request a verdict ("OK", "Changes requested" or "Blocked").'
        );
      }
      return;
    }
  }

  async function createTask(overrides?: { repo?: string; title?: string }) {
    const current = detailRef.current ?? detail;
    if (!current) return;
    if (current.session.issueNumber || current.session.boardItemId) {
      setNotice("This session already has a task.");
      return;
    }
    const repo = overrides?.repo?.trim() || current.session.repo;
    if (!repo && !overrides) {
      // Let the user confirm whether this should be a Project draft item or a repo issue.
      setCreateTaskOpen(true);
      return;
    }
    // Use the analysis Agent 1 produced during the idea discussion (TWINDEM_BODY block) as the
    // task body, instead of the raw idea seed. Falls back to the seed if the agent didn't emit one.
    const analysisBody = parseTwindemBody(streamBuffers.current.L) ?? undefined;
    const ideaType = inferIdeaType({
      explicit: current.session.ideaType,
      title: overrides?.title?.trim() || current.session.title,
      labels: current.github?.labels
    });
    setCreatingTask(true);
    try {
      await run(async () => {
        const updated = await unwrap(
          window.tandem.board.createTask(current.session.id, {
            repo,
            title: overrides?.title,
            body: analysisBody,
            labels: labelsForIdeaType(ideaType)
          })
        );
        // Enter the analysis step: Agent 1 writes the body next.
        await unwrap(window.tandem.conductor.update(current.session.id, { currentStepId: "inbox-analysis", activeSide: "L" }));
        // Use the FRESH detail (now has the linked issue + URL) and sync the ref immediately, so the
        // review instruction we build below actually contains the task link.
        const fresh = await unwrap(window.tandem.sessions.get(current.session.id));
        setDetail(fresh);
        detailRef.current = fresh ?? detailRef.current;
        setSessions(await unwrap(window.tandem.sessions.list()));
        setCreateTaskOpen(false);
        // Clear A1's buffer so any "ready" bundled with the create signal doesn't immediately fire a
        // premature review — the idea review starts only when A1 emits a FRESH ready after clarifying.
        streamBuffers.current.L = "";
        handledMarkers.current.clear();
        reviewRoundRef.current = 0;
        awaitingSide.current = null;
        const boardRef = fresh ? boardArtifactRefForSession(fresh.session) : null;
        if (fresh && boardRef) {
          await submitInstruction(
            "L",
            [
              `Twindem confirmation: the board task was created successfully as ${boardRef}.`,
              fresh.board?.url || fresh.github?.url ? `URL: ${fresh.board?.url ?? fresh.github?.url}` : "",
              "Use this board item as the source of truth from now on.",
              "Do not assume the task existed before this confirmation.",
              "Stay in Inbox: ask any remaining clarification questions and wait for the human to start Refinement."
            ].filter(Boolean).join("\n")
          ).catch((error) => setErrorNotice(error instanceof Error ? error.message : String(error)));
        }
        // Do NOT hand off to A2 yet — Agent 1 first clarifies any open questions with the human.
        setNotice(`Task created: ${boardArtifactRefForSession(updated.session)} — Inbox. Clarify open questions with Agent 1; it goes to review when Agent 1 is ready.`);
      });
    } finally {
      setCreatingTask(false);
    }
  }

  // Manual macro-gate: advance the task to the given phase and kick off that phase's lead agent.
  // Re-read the config straight from disk so the release runbooks (and anything else) always use
  // the latest saved Settings on-the-fly, without depending on React render timing.
  async function freshConfig(): Promise<TandemConfig | null> {
    const result = await window.tandem.config.get().catch(() => null);
    const cfg = result && result.ok ? result.data : configRef.current;
    if (cfg) {
      configRef.current = cfg;
      setConfig(cfg);
    }
    return cfg ?? null;
  }

  async function goToPhase(key: string, skipConfirmed = false) {
    // Don't reset the loop state out from under an in-flight handoff (double-delivery risk).
    if (handoffBusy.current || switchingAgent !== null) {
      setNotice("An agent handoff is in progress — wait a moment, then try again.");
      return;
    }
    if (phaseActionPendingRef.current) {
      setNotice("A phase change is already in progress — wait for it to finish.");
      return;
    }
    phaseActionPendingRef.current = key;
    setPhaseActionPending(key);
    try {
    // Any developer can move a story to any status. Three cases, by where the target sits relative to
    // the phase already reached:
    //   - FORWARD JUMP that skips steps → confirm first (skipped steps carry plan/review work).
    //   - BACKWARD move → board status ONLY; do NOT restart that step's agent. Going back is re-work /
    //     board correction; re-running analysis or implementation would spend tokens unexpectedly.
    //   - NEXT step (or re-running the current one) → move status + start that step's agent.
    if (key !== "create") {
      const currentForNav = detailRef.current ?? detail;
      const wsForNav = config ? activeWorkspace(config, currentForNav?.session.workspaceName) : undefined;
      const defs = phaseDefsForIdeaType(currentForNav?.session.ideaType);
      const targetIndex = defs.findIndex((d) => d.key === key);
      const restartable = restartablePhaseRef.current;
      const overrideReached =
        currentForNav && restartable?.sessionId === currentForNav.session.id ? restartable.reachedIndex : null;
      const reached = overrideReached ?? (currentForNav ? sessionPhaseReached(currentForNav, wsForNav) : -1);
      const restartCurrentStep =
        Boolean(currentForNav && restartable?.sessionId === currentForNav.session.id && restartable.key === key);
      if (!skipConfirmed && targetIndex > reached + 1) {
        setSkipPhaseConfirm({
          targetKey: key,
          targetLabel: defs[targetIndex]?.label ?? key,
          skipped: defs.slice(reached + 1, targetIndex).map((d) => d.label)
        });
        return;
      }
      // Backward move for the agent-driven steps → status-only (no agent restart, no token spend).
      const backwardSlot: BoardStatusSlot | undefined =
        key === "plan" ? "planning" : key === "implement" ? "in_progress" : undefined;
      if (!restartCurrentStep && backwardSlot && targetIndex >= 0 && targetIndex < reached && currentForNav) {
        await run(async () => {
          const moved = await changeBoardStatus(boardStatusForSlot(backwardSlot, wsForNav), backwardSlot);
          if (moved) {
            setReviewPassed(false);
            setPendingHandoff(null);
            restartablePhaseRef.current = { sessionId: currentForNav.session.id, key, reachedIndex: targetIndex };
            setNotice(`Moved back to ${defs[targetIndex]?.label ?? key} — board only, agents not restarted. Click the step again to restart its work.`);
          }
        });
        return;
      }
      if (restartCurrentStep || restartable?.key !== key) {
        restartablePhaseRef.current = null;
      }
    }
    // New phase → fresh review loop.
    setReviewPassed(false);
    setPendingHandoff(null);
    reviewRoundRef.current = 0;
    awaitingSide.current = null;
    if (key === "create") {
      await createTask();
      return;
    }
    const current = detailRef.current ?? detail;
    if (!current) return;
    const workspace = config ? activeWorkspace(config, current.session.workspaceName) : undefined;
    await run(async () => {
      if (key === "plan") {
        setSwitchingAgent("L");
        const moved = await changeBoardStatus(boardStatusForSlot("planning", workspace), "planning");
        if (!moved) {
          setSwitchingAgent(null);
          return;
        }
        await submitInstruction("L", analysisInstruction(detailRef.current ?? current, 1, workspace));
        setNotice("Refinement: technical-plan briefing sent to Agent 1");
      } else if (key === "implement") {
        const type = ideaTypeDefinition((detailRef.current ?? current).session.ideaType);
        setSwitchingAgent("L");
        const moved = await changeBoardStatus(boardStatusForSlot("in_progress", workspace), "in_progress");
        if (!moved) {
          setSwitchingAgent(null);
          return;
        }
        await submitInstruction("L", implementInstruction(detailRef.current ?? current, 1, agentSignature("L"), workspace));
        setNotice(`${phaseActionText(type).implementLabel}: briefing sent to Agent 1`);
      } else if (key === "uat") {
        // changeBoardStatus("UAT") only OPENS the gated deploy modal — the move happens after the
        // human confirms there, so no success notice here (it would lie if they cancel).
        await changeBoardStatus(boardStatusForSlot("uat", workspace), "uat");
      } else if (key === "prod") {
        const type = ideaTypeDefinition((detailRef.current ?? current).session.ideaType);
        // Non-implementation types, OR a board-only (non-deployable) project, just move to Done — no
        // release runbook / deploy flow applies.
        if (!type.requiresImplementation || !isDeployableWorkspace(config, workspace)) {
          await transitionWorkflow("done");
          return;
        }
        // If the operator wrote a PROD runbook, the Release Operator runs it FIRST; the task moves
        // to Done only when Agent 2 signals the release succeeded (completeProdRelease) — not before,
        // and not while the deploy is still running.
        const liveConfig = await freshConfig();
        const prodWorkspace = liveConfig ? activeWorkspace(liveConfig, current.session.workspaceName) : undefined;
        const runbook = prodWorkspace?.prodReleaseInstructions?.trim();
        if (runbook) {
          await submitInstruction("R", releaseOpsInstruction(detailRef.current ?? current, "PRODUCTION", runbook, agentSignature("R"), prodWorkspace));
          setNotice("PROD release running on Agent 2 — the task moves to Done when it confirms success.");
        } else {
          // No runbook → manual release; record it and move to Done now.
          await completeProdRelease();
        }
      }
    });
    } finally {
      phaseActionPendingRef.current = null;
      setPhaseActionPending(null);
    }
  }

  // Recovery for a forgetful agent: it finished its step but never wrote the signal file, so the
  // Auto loop is waiting on nothing. One click asks the agent whose turn it is to signal now.
  async function nudgeAgentSignal() {
    const current = detailRef.current ?? detail;
    if (!current) return;
    const side: AgentSide = awaitingSide.current ?? "L";
    const prompt =
      side === "R"
        ? `Twindem: if your review is complete, write your verdict signal file NOW — ${signalLine(current.session.id, "A2", '{"phase":"review","verdict":"OK"}')} (replace OK with "Changes requested" or "Blocked" as appropriate). If the review is not finished, continue and write it when done.`
        : `Twindem: if your current step is complete (open questions resolved / plan or implementation ready), write your signal file NOW — ${signalLine(current.session.id, "A1", '{"phase":"ready"}')} If it is not complete, continue working and write it when done.`;
    await run(async () => {
      await submitInstruction(side, prompt);
      setNotice(`Asked ${side === "L" ? "Agent 1" : "Agent 2"} to write its signal file.`);
    });
  }

  async function sendToReviewer() {
    const current = detailRef.current ?? detail;
    if (!current) return;
    await run(async () => {
      await runReviewHandoff(detailRef.current ?? current);
    });
  }

  // On boards where the agents can't write (Jira — no gh), Twindem posts A2's verdict + findings so the
  // iteration trail lands on the board. On GitHub the agent posts via gh, so this is a no-op there.
  async function postReviewVerdictToBoard(detailNow: SessionDetail, verdict?: string, findings?: ReviewFinding[]): Promise<boolean> {
    const configNow = configRef.current;
    const workspace = configNow ? activeWorkspace(configNow, detailNow.session.workspaceName) : undefined;
    if (boardProviderForWorkspace(configNow, workspace) === "github_project") return false;
    if (!isBoardSession(detailNow)) return false;
    const round = reviewRoundRef.current || 1;
    const markerKey = `${detailNow.session.id}:verdict-comment:${round}:${verdict ?? "?"}`;
    if (handledMarkers.current.has(markerKey)) return false;
    handledMarkers.current.add(markerKey);
    try {
      await unwrap(window.tandem.board.commentArtifact(detailNow.session.id, reviewVerdictComment(round, verdict, findings)));
      return true;
    } catch (error) {
      handledMarkers.current.delete(markerKey);
      const message = error instanceof Error ? error.message : String(error);
      setErrorNotice(`Couldn't post the review comment to the board: ${message}`);
      return false;
    }
  }

  // Rollback with a destination: the chosen status is applied when Agent 2 signals the rollback
  // is done (signal {"phase":"rollback"}), so the board reflects reality, not intent.
  async function rollbackRelease(statusAfter?: string) {
    const current = detailRef.current ?? detail;
    if (!isBoardSession(current)) return;
    setRollbackMenuOpen(false);
    pendingRollbackStatusRef.current = statusAfter ?? null;
    await run(async () => {
      await submitInstruction("R", rollbackInstruction(detailRef.current ?? current, agentSignature("R")));
      setNotice(
        statusAfter
          ? `Rollback sent to Agent 2 — the task moves to "${statusAfter}" when it confirms.`
          : "Rollback instruction sent to the Release Operator (Agent 2)"
      );
    });
  }

  // A successful PROD release — record the release as the Done-gate evidence and move to Done.
  async function completeProdRelease() {
    const current = detailRef.current ?? detail;
    if (!isBoardSession(current)) return;
    await run(async () => {
      // The successful release IS the proof — satisfy the Done evidence gate so the move passes.
      for (const key of ["smoke_tests_recorded", "final_verification_comment"]) {
        await window.tandem.evidence
          .updateStatus(current.session.id, key, "done", "Recorded by Twindem on a successful PROD release")
          .catch(() => undefined);
      }
      const result = await unwrap(window.tandem.workflow.transition(current.session.id, "done"));
      applyWorkflowResult(result);
      setSessions(await unwrap(window.tandem.sessions.list()));
      if (result.warnings.some((w) => /status/i.test(w))) {
        setErrorNotice("Released to production, but couldn't set the board status to Done — set it manually from the status bar.");
      } else {
        setNotice("Released to production — task moved to Done ✓");
      }
    });
  }

  function openLinkedBug(parent: { key: string; repo?: string; issueNumber?: number; title: string; url?: string }) {
    setSessionMenuOpen(null);
    setMoreActionsOpen(false);
    setBugParent(parent);
    setNewSessionOpen(true);
  }

  // Report Bug from the ACTIVE task: a UAT-phase finding stays on the same task (comment + optional
  // send-back to fix); from Done (or no UAT) it becomes a NEW Bug linked to this task.
  function reportBugActive() {
    setMoreActionsOpen(false);
    const current = detailRef.current ?? detail;
    if (!isBoardSession(current)) {
      setNewSessionOpen(true);
      return;
    }
    const workspace = config ? activeWorkspace(config, current.session.workspaceName) : undefined;
    const phase = sessionPhaseReached(current, workspace);
    if (phase === 3) {
      setUatFindingModal({ sessionId: current.session.id, text: "", sendBack: true });
    } else {
      openLinkedBug({
        key: boardArtifactRefForSession(current.session),
        repo: current.session.repo,
        issueNumber: current.session.issueNumber,
        title: current.board?.title || current.github?.title || current.session.title,
        url: boardArtifactUrlForDetail(current)
      });
    }
  }

  // Report a bug against a task picked from the session list → always a new linked Bug.
  function reportBugFromSession(s: SessionSummary) {
    openLinkedBug({ key: boardArtifactRefForSession(s), repo: s.repo, issueNumber: s.issueNumber, title: s.title });
  }

  async function submitUatFinding() {
    const modal = uatFindingModal;
    if (!modal || !modal.text.trim()) return;
    const current = detailRef.current ?? detail;
    if (!isBoardSession(current)) return;
    setUatFindingModal(null);
    await run(async () => {
      await unwrap(
        window.tandem.board.commentArtifact(
          current.session.id,
          `### UAT finding\n\n${modal.text.trim()}\n\n_reported during UAT via Twindem_`
        )
      );
      if (modal.sendBack) {
        const workspace = config ? activeWorkspace(config, current.session.workspaceName) : undefined;
        await changeBoardStatus(boardStatusForSlot("in_progress", workspace), "in_progress");
        await submitInstruction("L", uatFixInstruction(detailRef.current ?? current, modal.text.trim(), agentSignature("L")));
        setNotice("UAT finding posted — task sent back to In Progress for Agent 1 to fix.");
      } else {
        setNotice("UAT finding posted as a comment on the task.");
      }
    });
  }

  // Done is available from Implement onward: comments the resolution (date + agent signature) and
  // moves the task to Done.
  async function markTaskDone() {
    const current = detailRef.current ?? detail;
    if (!isBoardSession(current)) return;
    await run(async () => {
      const date = new Date().toLocaleDateString("ro-RO", { year: "numeric", month: "2-digit", day: "2-digit" });
      // Best-effort resolution comment (provider-neutral; may be unavailable on some boards).
      await window.tandem.board
        .commentArtifact(current.session.id, `Task rezolvat la data de ${date}.\n\n_updated by ${agentSignature("L")} via Twindem_`)
        .catch(() => undefined);
      await changeBoardStatus(
        boardStatusForSlot("done", configRef.current ? activeWorkspace(configRef.current, current.session.workspaceName) : undefined),
        "done"
      );
      setNotice("Task marked Done ✓");
    });
  }

  // Merge the task's open PRs — delegated to the implementer agent, which knows the branches/PRs it
  // opened. The actual `gh pr merge` is gated by the CLI permission prompt in the terminal.
  async function mergeTaskPRs() {
    const current = detailRef.current ?? detail;
    if (!current || !isBoardSession(current)) {
      setErrorNotice("There's no board task with PRs to merge yet.");
      return;
    }
    await run(async () => {
      await submitInstruction("R", mergeInstruction(detailRef.current ?? current, agentSignature("R")));
      setNotice("Asked Agent 2 to merge the task's PRs — approve the merge command in its terminal.");
    });
  }

  async function proposeArchitectureTasks() {
    const current = detailRef.current ?? detail;
    if (!current) return;
    const workspace = config ? activeWorkspace(config, current.session.workspaceName) : undefined;
    const reached = sessionPhaseReached(current, workspace);
    if (current.session.ideaType !== "architecture" || reached < 3) {
      setErrorNotice("Follow-up tasks can be proposed after the Architecture ADR reaches approval.");
      return;
    }
    setProposingTasks(true);
    try {
      await run(async () => {
        await submitInstruction("L", architectureTaskProposalInstruction(current, workspace));
        setNotice("Asked Agent 1 to propose follow-up tasks from the approved ADR.");
      });
    } finally {
      setProposingTasks(false);
    }
  }

  async function createSelectedFollowUpTasks() {
    const modal = taskProposalModal;
    if (!modal) return;
    const prepared = modal.tasks.map((task) => {
      if (task.status === "created") return task;
      if (task.status === "skipped") return task;
      return { ...task, status: task.status === "failed" ? "failed" : "selected" } satisfies ProposedTask;
    });
    setTaskProposalModal({ ...modal, tasks: prepared, creating: true });
    await run(async () => {
      const result = await unwrap(window.tandem.workflow.createFollowUpTasks(modal.sourceSessionId, prepared));
      const created = result.filter((task) => task.status === "created").length;
      const failed = result.filter((task) => task.status === "failed").length;
      setSessions(await unwrap(window.tandem.sessions.list()));
      if (failed === 0) {
        setTaskProposalModal(null);
        await clearActiveWorkContext(
          `Created ${created} follow-up task${created === 1 ? "" : "s"} on the board. Pick a task from the list to continue.`
        );
        return;
      }
      setTaskProposalModal({
        ...modal,
        tasks: result,
        creating: false
      });
      setNotice(
        `Created ${created} follow-up task${created === 1 ? "" : "s"}; ${failed} failed and can be retried.`
      );
    }).finally(() => {
      setTaskProposalModal((current) => (current && current.sourceSessionId === modal.sourceSessionId ? { ...current, creating: false } : current));
    });
  }

  async function sendFindingsToAuthor() {
    const current = detailRef.current ?? detail;
    if (!current) return;
    if (handoffBusy.current) return;
    handoffBusy.current = true;
    awaitingSide.current = "L";
    setPendingHandoff(null);
    setReviewPassed(false);
    try {
      await run(async () => {
        await submitInstruction(
          "L",
          correctionsInstruction(detailRef.current ?? current, reviewRoundRef.current, agentSignature("L"), lastReviewFindingsRef.current)
        );
        lastReviewFindingsRef.current = lastReviewFindingsRef.current.map((finding) => ({ ...finding, status: "addressed" }));
        setNotice("Reviewer findings sent to Agent 1");
      });
    } finally {
      handoffBusy.current = false;
    }
  }

  // Manual update of the task body from Agent 1's latest plan. Only Agent 1 edits the body; Agent 2
  // comments. We REPLACE with the single authoritative plan (not append) so there's never an old +
  // new version confusing the reviewer.
  async function updateTaskFromAgent1() {
    const current = detailRef.current ?? detail;
    const hasBoard = isBoardSession(current);
    if (!current || !hasBoard) {
      setErrorNotice("There's no board task to update yet.");
      return;
    }
    // Prefer the chat block (freshest), fall back to the body file the agent keeps up to date —
    // the most instruction-compliant agents skip chat markers entirely.
    let conclusions = parseTwindemBody(streamBuffers.current.L);
    if (!conclusions) {
      const fileBody = await window.tandem.signals.readIdeaBody(current.session.id, true).catch(() => null);
      if (fileBody?.ok && fileBody.data) conclusions = fileBody.data;
    }
    if (!conclusions) {
      setErrorNotice(
        `No fresh plan from Agent 1. Ask Agent 1 to write its latest plan to .twindem/ideas/${current.session.id}.md (or output a TWINDEM_BODY block), then try again.`
      );
      return;
    }
    await run(async () => {
      const combined = `${conclusions}\n\n_updated by ${agentSignature("L")} via Twindem_`;
      lastAppendedBodyRef.current = conclusions ?? "";
      const updated = await unwrap(window.tandem.board.updateArtifactBody(current.session.id, combined));
      setDetail(updated);
      setNotice("Task body replaced with Agent 1's latest plan.");
    });
  }

  async function confirmNativeGate() {
    if (!nativeGateModal || !detail) return;

    if (nativeGateModal.kind === "start-planning") {
      setNativeGateModal(null);
      await run(async () => {
        if (panes.L.status !== "running") await startAgentProcess("L");
        await sendAgentInstruction(
          "L",
          workflowInstructionTemplate(
            config,
            detail,
            "planning",
            [
              "Human gate approved: start planning.",
              "Perform technical implementation analysis for the attached board artifact.",
              "Update the issue body/comment with implementation design, risks, affected areas, acceptance criteria, and test plan.",
              "When Definition of Ready is complete, end with marker: DOR MET.",
              'Finish with: TWINDEM_RESULT: {"marker":"DOR MET","verdict":"OK","summary":"...","nextAction":"choose implementer"}'
            ].join("\n")
          )
        );
        setNotice("Planning gate approved");
      });
      return;
    }

    if (nativeGateModal.kind === "choose-implementer") {
      const side = nativeGateModal.side;
      const nextPanes = {
        ...panes,
        [side]: { ...panes[side], provider: nativeGateModal.provider }
      };
      setNativeGateModal(null);
      setPanes(nextPanes);
      await run(async () => {
        await unwrap(
          window.tandem.conductor.update(detail.session.id, {
            currentStepId: "implementation",
            chosenImplementerSide: side,
            chosenImplementerProvider: nativeGateModal.provider
          })
        );
        if (panes[side].status === "running") await unwrap(window.tandem.agents.stop(side));
        await startAgentProcess(side, detail, nextPanes, config);
        await sendAgentInstruction(
          side,
          workflowInstructionTemplate(
            config,
            detail,
            "implementation",
            [
              "Human gate approved: you are the selected implementer.",
              "Implement the attached board artifact according to Definition of Ready.",
              "Keep changes scoped, record tests, and link branch/PR evidence.",
              "When ready for code review, end with marker: IMPLEMENTATION READY.",
              'Finish with: TWINDEM_RESULT: {"marker":"IMPLEMENTATION READY","verdict":"OK","summary":"...","nextAction":"code review"}'
            ].join("\n")
          )
        );
        setNotice(`${side === "L" ? "Agent 1" : "Agent 2"} selected as implementer`);
      });
      return;
    }

    if (nativeGateModal.kind === "approve-uat") {
      setNativeGateModal(null);
      if (nativeGateModal.mode === "approval") {
        const current = detailRef.current ?? detail;
        const workspace = config ? activeWorkspace(config, current.session.workspaceName) : undefined;
        const targetStatus = boardStatusForSlot("uat", workspace);
        await run(async () => {
          const result = await unwrap(window.tandem.board.updateStatus(current.session.id, targetStatus, "uat"));
          applyWorkflowResult(result);
          setWorkflowWarnings(result.warnings);
          setSessions(await unwrap(window.tandem.sessions.list()));
          const phaseText = phaseActionText(ideaTypeDefinition(current.session.ideaType));
          if (result.warnings.some((w) => /status/i.test(w))) {
            setErrorNotice(`Couldn't set the board status to ${targetStatus} — set it manually from the status bar.`);
          } else {
            setNotice(`Moved to ${phaseText.uatLabel}`);
          }
        });
        return;
      }
      await run(async () => {
        const liveConfig = (await freshConfig()) ?? config;
        const workspace = liveConfig ? activeWorkspace(liveConfig, detail.session.workspaceName) : undefined;
        const uatRunbook = workspace?.uatReleaseInstructions?.trim();
        if (uatRunbook) {
          // Operator wrote a UAT runbook in Settings — the Release Operator executes it verbatim.
          await submitInstruction("R", releaseOpsInstruction(detailRef.current ?? detail, "UAT", uatRunbook, agentSignature("R"), workspace));
          const result = await unwrap(window.tandem.workflow.transition(detail.session.id, "uat"));
          applyWorkflowResult(result);
          setSessions(await unwrap(window.tandem.sessions.list()));
          if (result.warnings.some((w) => /status/i.test(w))) {
            setErrorNotice("UAT runbook sent, but couldn't set the board status to UAT — set it manually from the status bar.");
          } else {
            setNotice("UAT runbook sent to Agent 2 — task moved to UAT.");
          }
          return;
        }
        if (workspace?.uatDeployCommand?.trim()) {
          const deployResult = await unwrap(window.tandem.workflow.deployUat(detail.session.id));
          applyWorkflowResult(deployResult);
        } else {
          const deploySide = detail.conductor?.chosenImplementerSide ?? "R";
          const deployProvider = detail.conductor?.chosenImplementerProvider;
          const nextPanes = deployProvider
            ? { ...panes, [deploySide]: { ...panes[deploySide], provider: deployProvider } }
            : panes;
          if (deployProvider) setPanes(nextPanes);
          if (deployProvider && panes[deploySide].status === "running" && panes[deploySide].provider !== deployProvider) {
            await unwrap(window.tandem.agents.stop(deploySide));
          }
          if (panes[deploySide].status !== "running" || panes[deploySide].provider !== nextPanes[deploySide].provider) {
            await startAgentProcess(deploySide, detail, nextPanes, config);
          }
          await sendAgentInstruction(
            deploySide,
            workflowInstructionTemplate(
              config,
              detail,
              "uatDeploy",
              [
                "Human gate approved: deploy or trigger deploy to UAT for the attached task.",
                "Use the repository/runbook/CI flow available in the workspace. Do not touch PROD.",
                "After the UAT deploy trigger completes, record concrete evidence: command, CI link, rollout signal, or blocking reason.",
                "Then finish with:",
                'TWINDEM_RESULT: {"verdict":"OK","summary":"UAT deploy evidence recorded","nextAction":"uat validation"}'
              ].join("\n")
            )
          );
          const updated = await unwrap(
            window.tandem.evidence.updateStatus(
              detail.session.id,
              "deploy_evidence",
              "done",
              `UAT deploy delegated to ${agentDisplayName(config, panes[deploySide].provider, deploySide)} by human gate at ${new Date().toISOString()}`
            )
          );
          setDetail(updated);
        }
        const result = await unwrap(window.tandem.workflow.transition(detail.session.id, "uat"));
        applyWorkflowResult(result);
        setSessions(await unwrap(window.tandem.sessions.list()));
        if (result.warnings.some((w) => /status/i.test(w))) {
          setErrorNotice("UAT deploy delegated, but couldn't set the board status to UAT — set it manually from the status bar.");
        } else {
          setNotice(workspace?.uatDeployCommand?.trim() ? "UAT deploy command ran and task moved to UAT" : "UAT deploy delegated and task moved to UAT");
        }
      });
      return;
    }

    setNativeGateModal(null);
    setNotice("Human decision recorded");
  }

  async function transitionWorkflow(target: WorkflowTransitionTarget) {
    if (!detail) return;
    await run(async () => {
      const result = await unwrap(window.tandem.workflow.transition(detail.session.id, target));
      applyWorkflowResult(result);
      setSessions(await unwrap(window.tandem.sessions.list()));
      if (result.warnings.some((w) => /status/i.test(w))) {
        const workspace = config ? activeWorkspace(config, detail.session.workspaceName) : undefined;
        setErrorNotice(`Couldn't set the board status to ${target === "uat" ? boardStatusForSlot("uat", workspace) : boardStatusForSlot("done", workspace)} — set it manually from the status bar.`);
      } else {
        const text = phaseActionText(ideaTypeDefinition(detail.session.ideaType));
        setNotice(target === "uat" ? `Moved to ${text.uatLabel}` : `${text.doneLabel} ✓`);
      }
    });
  }

  async function changeBoardStatus(status: string, slotArg?: BoardStatusSlot): Promise<boolean> {
    const current = detailRef.current ?? detail;
    if (!current) return false;
    const cfg = configRef.current ?? config;
    const workspace = cfg ? activeWorkspace(cfg, current.session.workspaceName) : undefined;
    // Trust the caller's explicit slot; only fall back to deriving it from the status name (ambiguous
    // when two slots share a status, e.g. uat and in_progress both → "In Progress").
    const slot = slotArg ?? slotForBoardStatus(status, workspace);
    if (slot === "uat") {
      const type = ideaTypeDefinition(current.session.ideaType);
      const phaseText = phaseActionText(type);
      if (!type.requiresImplementation) {
        setNativeGateModal({
          kind: "approve-uat",
          mode: "approval",
          title: `${phaseText.uatLabel}?`,
          body: `Changing the board status to ${boardStatusForSlot("uat", workspace)} moves this ${type.label.toLowerCase()} task into human approval. No UAT deploy or release runbook will run.`,
          confirmLabel: phaseText.uatLabel
        });
        return false;
      }
      // Board-only (non-deployable) feature/bug: there are no PRs/deploys to gate on, so UAT is a plain
      // human status move — fall through to the generic move below instead of the deploy modal.
      if (!isDeployableWorkspace(cfg, workspace)) {
        // (intentional fall-through)
      } else {
      // Best-effort: refresh and warn if linked PRs are still OPEN. Move to UAT does NOT merge them,
      // so deploying with unmerged PRs usually ships the wrong code.
      let warning = "";
      try {
        const synced = await window.tandem.board
          .syncArtifact(current.session.id)
          .then((r) => (r.ok ? r.data : null))
          .catch(() => null);
        if (synced) {
          const refreshed = await window.tandem.sessions
            .get(current.session.id)
            .then((r) => (r.ok ? r.data : null))
            .catch(() => null);
          if (refreshed) {
            detailRef.current = refreshed;
            setDetail(refreshed);
          }
          const openPrs = (synced.linkedPrs ?? []).filter((pr) => /open/i.test(pr.state));
          if (openPrs.length > 0) {
            warning =
              `⚠️ ${openPrs.length} linked PR${openPrs.length === 1 ? " is" : "s are"} still OPEN ` +
              `(${openPrs.map((pr) => `#${pr.number}`).join(", ")}). "Move to UAT" does NOT merge them — ` +
              "merge them first, or make sure your UAT runbook deploys the right branches.\n\n";
          }
        }
      } catch {
        /* best-effort — the gate still opens without the warning */
      }
      setNativeGateModal({
        kind: "approve-uat",
        mode: "deploy",
        title: "Approve UAT deploy?",
        body: `${warning}Changing the board status to UAT runs the gated UAT deploy/evidence flow.`
      });
      return false;
      }
    }
    let ok = false;
    await run(async () => {
      const result = await unwrap(window.tandem.board.updateStatus(current.session.id, status, slot ?? undefined));
      applyWorkflowResult(result);
      setWorkflowWarnings(result.warnings);
      setSessions(await unwrap(window.tandem.sessions.list()));
      ok = result.warnings.length === 0;
      if (ok) {
        setNotice(`Board status changed to ${status}`);
      } else {
        // Surface the detailed warning (it lists the statuses the board actually offers) instead of a
        // generic message, so the user knows exactly what to map.
        setErrorNotice(
          result.warnings[0] ||
            `Couldn't set the board status to ${status}. No agent instruction was sent; update the board mapping/status and try again.`
        );
      }
    });
    return ok;
  }

  async function updateEvidenceStatus(key: string, status: EvidenceStatus) {
    if (!detail) return;
    if (status === "na" || status === "blocked") {
      setEvidenceModal({ key, status, reason: "" });
      return;
    }
    await run(async () => {
      const updated = await unwrap(window.tandem.evidence.updateStatus(detail.session.id, key, status));
      setDetail(updated);
      setSessions(await unwrap(window.tandem.sessions.list()));
      setNotice(`Evidence marked ${status}`);
    });
  }

  async function confirmEvidenceStatus() {
    if (!detail || !evidenceModal || !evidenceModal.reason.trim()) return;
    await run(async () => {
      const updated = await unwrap(
        window.tandem.evidence.updateStatus(
          detail.session.id,
          evidenceModal.key,
          evidenceModal.status,
          evidenceModal.reason.trim()
        )
      );
      setDetail(updated);
      setSessions(await unwrap(window.tandem.sessions.list()));
      setNotice(`Evidence marked ${evidenceModal.status}`);
      setEvidenceModal(null);
    });
  }

  async function openSettings() {
    setSettingsOpen(true);
    await refreshGithubAuth();
  }

  async function refreshGithubAuth() {
    setGithubAuthChecking(true);
    await run(async () => {
      const status = await unwrap(window.tandem.board.authStatus());
      setGithubAuthStatus(status);
    });
    setGithubAuthChecking(false);
  }

  async function connectGithubAuth() {
    setGithubAuthChecking(true);
    await run(async () => {
      const status = await unwrap(window.tandem.board.authStatus());
      if (status.ok) {
        setGithubAuthStatus(status);
        setNotice(status.message);
        return;
      }
      const login = await unwrap(window.tandem.board.connect());
      setGithubAuthStatus(login);
      setNotice(login.message);
    });
    setGithubAuthChecking(false);
  }

  async function saveSettings(nextConfig: TandemConfig) {
    await run(async () => {
      const prevConfig = config;
      const saved = await unwrap(window.tandem.config.save(nextConfig));
      setConfig(saved);
      setPanes(detail ? panesFromSession(detail, saved) : panesFromConfig(saved));
      // If the active project's board provider or selected project changed, drop the cached board
      // browser so "Show board" re-fetches the new provider instead of showing stale items / label /
      // error from the old one.
      const activeName = detail?.session.workspaceName ?? saved.defaults.workspaceName;
      const prevWs = prevConfig ? activeWorkspace(prevConfig, activeName) : undefined;
      const nextWs = activeWorkspace(saved, activeName);
      const boardChanged =
        boardProviderForWorkspace(prevConfig, prevWs) !== boardProviderForWorkspace(saved, nextWs) ||
        prevWs?.githubOwner !== nextWs?.githubOwner ||
        prevWs?.projectNumber !== nextWs?.projectNumber ||
        prevWs?.jiraProjectKey !== nextWs?.jiraProjectKey;
      if (boardChanged) {
        setBoardArtifacts([]);
        setBoardSyncedAt(null);
        setBoardError(null);
        setBoardLoading(false);
      }
      setSettingsOpen(false);
      setNotice("Settings saved");
    });
  }

  async function handleProjectDeleted(deletedName: string, deletedSessions: number, sourceFolderDeleted?: boolean) {
    const refreshed = await window.tandem.config.get().then((r) => (r.ok ? r.data : null)).catch(() => null);
    if (refreshed) {
      setConfig(refreshed);
      setPanes(panesFromConfig(refreshed));
    }
    const nextSessions = await unwrap(window.tandem.sessions.list()).catch(() => []);
    setSessions(nextSessions);
    if (detail?.session.workspaceName === deletedName) {
      setDetail(null);
      detailRef.current = null;
    }
    setNotice(
      `Deleted project "${deletedName}" — ${deletedSessions} task${deletedSessions === 1 ? "" : "s"} and all local data removed.${sourceFolderDeleted ? " Source folder deleted too." : " Source folder kept."}`
    );
  }

  async function switchActiveProject(name: string) {
    if (!config || config.defaults.workspaceName === name) return;
    await run(async () => {
      const saved = await unwrap(window.tandem.config.save({
        ...config,
        defaults: { ...config.defaults, workspaceName: name }
      }));
      setConfig(saved);
      if (detail?.session.workspaceName && detail.session.workspaceName !== name) {
        await unwrap(window.tandem.sessions.setActive(null));
        setDetail(null);
        setPanes(panesFromConfig(saved));
      } else if (!detail) {
        setPanes(panesFromConfig(saved));
      }
      setNotice(`Active project: ${name}`);
    });
  }

  async function saveOnboarding(nextConfig: TandemConfig) {
    await run(async () => {
      const savedRaw = await unwrap(window.tandem.config.save(nextConfig));
      const saved = ensureSessionWorkspaces(savedRaw, sessions);
      if (saved !== savedRaw) await unwrap(window.tandem.config.save(saved));
      setConfig(saved);
      setPanes(panesFromConfig(saved));
      setOnboardingOpen(false);
      if (sessions.length === 0) setNewSessionOpen(true);
      setNotice(onboardingMode === "new-project" ? "Project created" : "Setup saved");
    });
  }

  const evidenceDone = useMemo(() => {
    if (!detail) return 0;
    return detail.evidence.filter((item) => item.status === "done").length;
  }, [detail]);
  const currentWorkspace = config && detail ? activeWorkspace(config, detail.session.workspaceName) : config ? activeWorkspace(config) : undefined;
  const artifactDisplay = activeArtifactDisplay(detail, currentWorkspace);
  // Follow the active agent into the visible tab/composer target when the turn changes
  // (adjust-state-on-change pattern — avoids a cascading-render effect).
  const persistedActiveSide = detail?.conductor?.activeSide;
  if (persistedActiveSide && persistedActiveSide !== lastActiveSide) {
    setLastActiveSide(persistedActiveSide);
    setActiveTab(persistedActiveSide);
  }
  const conductorState = deriveConductorState(detail, currentWorkspace);
  const phaseHasIssue = isBoardSession(detail);
  const phaseReached = phaseHasIssue && detail ? sessionPhaseReached(detail, currentWorkspace) : -1;
  const activeIdeaType = ideaTypeDefinition(detail?.session.ideaType);
  const phaseDefs = phaseDefsForIdeaType(detail?.session.ideaType);
  const turnIndicator = deriveTurnIndicator(detail, conductorState);
  const restoreState = deriveRestoreState(detail);
  const sessionWelcome = deriveSessionWelcome(detail, currentWorkspace);
  const [welcomeDismissed, setWelcomeDismissed] = useState<string | null>(null);
  const showWelcome = sessionWelcome && !restoreState
    && panes.L.status !== "running" && panes.R.status !== "running"
    && welcomeDismissed !== detail?.session.id;

  useEffect(() => {
    const needsAttention = terminalAttention || Boolean(folderTrustModal) || Boolean(nativeGateModal);
    void window.tandem.app.setAttentionBadge(needsAttention).catch(() => undefined);
  }, [terminalAttention, folderTrustModal, nativeGateModal]);

  if (bootstrapping || !config) {
    return (
      <main className="app-loading-shell">
        <div className="app-loading-card">
          <TwindemLoader size={72} />
          <strong>{bootError ? "Twindem could not start" : "Loading Twindem"}</strong>
          <span>{bootError ?? "Opening projects and sessions..."}</span>
        </div>
      </main>
    );
  }

  const renderTaskCard = (session: SessionSummary) => {
    const badge = taskBadge(session, config ? activeWorkspace(config, session.workspaceName) : undefined);
    const ref = session.boardItemKey ?? (session.repo && session.issueNumber ? `${session.repo}#${session.issueNumber}` : null);
    return (
      <div
        key={session.id}
        className={`session-card ${session.id === activeSession?.id ? "active" : ""}${session.hidden ? " hidden" : ""}`}
      >
        <button className="session-card-main" onClick={() => void openSession(session.id)}>
          <span className="session-card-copy">
            <span className="session-card-title-row">
              <strong>{session.title}</strong>
              {session.hidden && <span className="session-hidden-badge">hidden</span>}
              {(() => {
                const sessionProvider = sessionBoardProvider(session);
                const workspaceProvider = config
                  ? boardProviderForWorkspace(config, activeWorkspace(config, session.workspaceName))
                  : sessionProvider;
                if (sessionProvider === "none" || sessionProvider === workspaceProvider) return null;
                return (
                  <span
                    className="session-original-board-badge"
                    title={`This task is on its original board (${sessionProvider === "jira" ? "Jira" : "GitHub"}), which differs from the project's current board.`}
                  >
                    original board
                  </span>
                );
              })()}
            </span>
            <span className={`task-badge badge-${badge.key}`}>{badge.label}</span>
            {session.initialBody && <span className="session-card-desc">{compactUiText(session.initialBody, 140)}</span>}
            <small className="task-meta">
              {ideaTypeDefinition(session.ideaType).label}
              {ref ? ` · ${ref}` : " · local"}
              {session.spawnedFromBoardRef ? ` · from ${session.spawnedFromBoardRef}` : ""}
            </small>
          </span>
        </button>
        <div className="session-card-menu-wrap">
          <button
            className="session-card-menu-button"
            aria-label="Task options"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setSessionMenuAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
              setSessionMenuOpen((current) => (current === session.id ? null : session.id));
            }}
          >
            ...
          </button>
          {sessionMenuOpen === session.id && (
            <>
              <button className="session-menu-scrim" aria-label="Close task menu" onClick={() => setSessionMenuOpen(null)} />
              <div
                className="session-card-menu"
                style={sessionMenuAnchor ? { position: "fixed", top: sessionMenuAnchor.top, right: sessionMenuAnchor.right } : undefined}
              >
                <button onClick={() => openSessionEdit(session)}>Edit</button>
                {hasBoardArtifactSession(session) && (
                  <button onClick={() => reportBugFromSession(session)}>🐞 Report a bug</button>
                )}
                <button onClick={() => void downloadSession(session.id)}>Download</button>
                <button onClick={() => void toggleSessionHidden(session)}>{session.hidden ? "Unhide" : "Hide"}</button>
                <button
                  className="danger"
                  onClick={() => {
                    setSessionMenuOpen(null);
                    void deleteSession(session.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <main className="app-shell" style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img className="brand-logo" src={twindemLogo} alt="Twindem" width={34} height={34} />
          </div>
          <div>
            <h1>Twindem</h1>
            <p>Provable AI delivery.</p>
          </div>
        </div>
        {config && (
          <label className="active-project-switcher">
            <span>Project</span>
            <select
              value={config.defaults.workspaceName ?? config.workspaces[0]?.name ?? ""}
              onChange={(event) => void switchActiveProject(event.target.value)}
            >
              {config.workspaces.map((workspace) => (
                <option key={workspace.name} value={workspace.name}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="primary wide" onClick={() => setNewSessionOpen(true)}>
          New session
        </button>
        <section className="sessions-section">
          <div className="sessions-head">
            <div className="sessions-head-title">
              <h2>Tasks</h2>
              <small>the work Twindem is driving</small>
            </div>
            <div className="session-filter-wrap">
              <button
                className="session-filter-btn"
                onClick={() => setSessionFilterOpen((open) => !open)}
                title="Filter sessions by time"
                aria-expanded={sessionFilterOpen}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M1.5 3h13L9.5 9v4.5L6.5 12V9L1.5 3Z" fill="currentColor" />
                </svg>
                {SESSION_FILTERS.find((f) => f.key === sessionFilter)?.label ?? "All"}
              </button>
              {sessionFilterOpen && (
                <div className="session-filter-menu">
                  {SESSION_FILTERS.map((filter) => (
                    <button
                      key={filter.key}
                      className={sessionFilter === filter.key ? "active" : ""}
                      onClick={() => {
                        setSessionFilter(filter.key);
                        setSessionFilterOpen(false);
                      }}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="session-search-row">
            <input
              className="session-search"
              placeholder="Search tasks…"
              value={sessionSearch}
              onChange={(event) => setSessionSearch(event.target.value)}
            />
            <button className="from-board-btn" onClick={() => void openBoardModal()} title="Pull an existing item from the full board into Twindem">
              + From board
            </button>
          </div>
          <div className="session-list">
            {visibleSessions.length === 0 ? (
              <div className="empty-panel small">
                {sessions.length === 0
                  ? "No tasks yet — start one from an idea, or pull one from the board."
                  : sessionSearch.trim() || sessionFilter !== "all"
                    ? "No tasks match the search/filter."
                    : "No tasks for this project yet."}
              </div>
            ) : (
              <>
                {taskSections.active.length > 0 && (
                  <div className="task-section">
                    <div className="task-section-head">
                      Active <span className="task-section-count">{taskSections.active.length}</span>
                    </div>
                    {taskSections.active.map(renderTaskCard)}
                  </div>
                )}
                {taskSections.notStarted.length > 0 && (
                  <div className="task-section">
                    <div className="task-section-head">
                      Not started <span className="task-section-count">{taskSections.notStarted.length}</span>
                    </div>
                    {taskSections.notStarted.map(renderTaskCard)}
                  </div>
                )}
                {taskSections.done.length > 0 && (
                  <div className="task-section">
                    <button className="task-section-head collapsible" onClick={() => setDoneCollapsed((c) => !c)} aria-expanded={!doneCollapsed}>
                      <span>{doneCollapsed ? "▸" : "▾"} Done</span>
                      <span className="task-section-count">{taskSections.done.length}</span>
                    </button>
                    {!doneCollapsed && taskSections.done.map(renderTaskCard)}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
        <footer className="sidebar-footer">
          <button onClick={() => {
            setOnboardingMode("setup");
            setOnboardingOpen(true);
          }}>Setup</button>
          <button onClick={() => void openSettings()}>Settings</button>
        </footer>
        <button
          className="sidebar-resize-handle"
          type="button"
          aria-label="Resize task sidebar"
          title="Resize task sidebar"
          onPointerDown={beginSidebarResize}
        />
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <span className="eyebrow">Active artifact</span>
            <h2>{artifactDisplay.title}</h2>
            <p className="artifact-meta">
              <span>{artifactDisplay.meta}</span>
              {artifactDisplay.status && <span>{artifactDisplay.status}</span>}
              {artifactDisplay.url && (
                <a href={artifactDisplay.url}>
                  Open issue
                </a>
              )}
            </p>
          </div>
          {detail && (
            <div className="topbar-controls">
              <div className="view-segment" role="tablist" aria-label="Pane layout">
                <button className={paneView === "tabs" ? "active" : ""} onClick={() => setPaneView("tabs")}>Tabs</button>
                <button className={paneView === "split" ? "active" : ""} onClick={() => setPaneView("split")}>Split</button>
              </div>
              <button
                className={contextOpen ? "context-toggle active" : "context-toggle"}
                onClick={() => setContextOpen((open) => !open)}
                aria-pressed={contextOpen}
              >
                {contextOpen ? "Hide context" : "Context"}
              </button>
              <button
                className="show-board"
                title="See the whole board (all columns and tasks) without leaving Twindem."
                onClick={() => void openBoardModal()}
              >
                ▦ Show board
              </button>
              <button
                className="show-board"
                disabled={!phaseHasIssue}
                title="Re-sync from the board and have Agent 1 re-assess the current state. Use this only if the issue/board changed outside Twindem — normal reopen costs no tokens."
                onClick={() => void resyncFromBoard()}
              >
                ⟳ Re-sync
              </button>
              {detail.session.artifactType === "idea" && !detail.session.issueNumber && !detail.session.boardItemId && (
                <button
                  className="show-board"
                  title="Send or resend the initial idea brief to Agent 1. Use this after approving a CLI folder trust prompt."
                  onClick={() => {
                    if (config) void sendInitialBriefing(detail, panesFromSession(detail, config), config);
                  }}
                >
                  Send brief
                </button>
              )}
              <button
                className="exit-all"
                title="Stop both agent CLIs and close the current session — back to the clean start screen."
                onClick={() => void exitAllSessions()}
              >
                ⏻ Exit all sessions
              </button>
            </div>
          )}
        </header>
        {detail ? (
        <>
        <BoardStatusBar
          detail={detail}
          workspace={currentWorkspace}
          onSync={() => void syncGithub()}
          onStatusChange={(status) => void changeBoardStatus(status)}
          onLinkIssue={() =>
            setAttachIssueModal({
              ref: activeSession?.repo && activeSession.issueNumber ? `${activeSession.repo}#${activeSession.issueNumber}` : "",
              continueToReview: false
            })
          }
        />

        <section className={`conductor-bar tone-${conductorState.checkpointTone}`}>
          <div className="conductor-bar-status">
            <span className={`turn-light ${turnIndicator.kind === "agent" ? "active" : turnIndicator.kind}`}>
              <i />
              {turnIndicator.kind === "agent"
                ? turnIndicator.side === "L"
                  ? "Agent 1"
                  : "Agent 2"
                : turnIndicator.kind === "human"
                  ? "Your move"
                  : "Waiting"}
            </span>
            <div className="conductor-bar-step">
              <strong>{conductorState.checkpointTitle}</strong>
              {conductorState.checkpointBody && <small>{conductorState.checkpointBody}</small>}
            </div>
            <span className="conductor-bar-round">
              Round {conductorState.round.n}/{conductorState.round.total}
            </span>
          </div>
          <div className="conductor-bar-actions stacked">
            <div className="conductor-row">
            <div className="phase-stepper">
              {phaseDefs.map((phase, index) => {
                // Release gating: for deployable / implementation tasks, only offer the UAT and
                // PRODUCTION release steps when the operator has written the matching runbook in
                // Settings → Release. With no instructions there's nothing to run, so the button is
                // hidden (finish via "✓ Done"). Non-implementation idea types keep these steps — there
                // UAT is a human approval checkpoint, not a deploy.
                if (activeIdeaType.requiresImplementation) {
                  if (phase.key === "uat" && !currentWorkspace?.uatReleaseInstructions?.trim()) return null;
                  if (phase.key === "prod" && !currentWorkspace?.prodReleaseInstructions?.trim()) return null;
                }
                const state = !phaseHasIssue
                  ? phase.key === "create"
                    ? "next"
                    : "future"
                  : index <= phaseReached
                    ? "done"
                    : index === phaseReached + 1
                      ? "next"
                      : "future";
                const isNext = state === "next";
                const reviewReady = isNext && reviewPassed;
                // Any step is clickable once a board task exists; before that, only "create".
                // "Create task" becomes a no-op once the task exists, so disable it then (shows done).
                // Forward jumps that skip steps are allowed but confirmed (see goToPhase).
                const clickable = phase.key === "create" ? !phaseHasIssue : phaseHasIssue;
                const phaseButton = (
                  <button
                    key={phase.key}
                    className={`phase-btn ${state}${reviewReady ? " review-passed" : ""}`}
                    disabled={!detail || !clickable || Boolean(phaseActionPending)}
                    title={
                      reviewReady
                        ? `Review passed ✓ — advance to ${phase.label}`
                        : isNext
                          ? `Next step: ${phase.hint}`
                          : state === "future"
                            ? `Jump ahead to ${phase.label} (skips steps — you'll confirm)`
                            : phase.hint
                    }
                    onClick={() => {
                      if (!phaseActionPending) void goToPhase(phase.key);
                    }}
                  >
                    {reviewReady ? `✓ ${phase.label}` : phase.label}
                  </button>
                );
                if (activeIdeaType.requiresImplementation && phase.key === "prod") {
                  return (
                    <Fragment key="merge-before-prod">
                      <button
                        className={`phase-btn merge-prs ${phaseReached >= 3 ? "next" : "future"}`}
                        disabled={!phaseHasIssue || phaseReached < 3 || phaseReached >= 4 || Boolean(phaseActionPending)}
                        title="Merge the task's open PR(s) before production — delegates to Agent 2 as Release Operator."
                        onClick={() => void mergeTaskPRs()}
                      >
                        ⛙ Merge PRs
                      </button>
                      {phaseButton}
                    </Fragment>
                  );
                }
                return phaseButton;
              })}
              {activeIdeaType.requiresImplementation && (
                <button
                  className="phase-btn done-now"
                  disabled={!phaseHasIssue || phaseReached < 2 || phaseReached >= 4 || Boolean(phaseActionPending)}
                  title="Mark the task Done now: comments the resolution date + agent signature, then moves the task to Done. Available from Implement onward."
                  onClick={() => void markTaskDone()}
                >
                  Move to Done
                </button>
              )}
              {detail.session.ideaType === "architecture" && (
                <button
                  className="phase-btn follow-up"
                  disabled={!phaseHasIssue || phaseReached < 3 || Boolean(taskProposalModal) || proposingTasks}
                  title="Ask Agent 1 to propose follow-up tasks from the approved ADR."
                  onClick={() => void proposeArchitectureTasks()}
                >
                  {proposingTasks ? (
                    <>
                      <span className="btn-spinner" />
                      Switching to Agent 1…
                    </>
                  ) : (
                    "Propose tasks"
                  )}
                </button>
              )}
              <div className="rollback-wrap">
                <button
                  className="phase-btn rollback"
                  disabled={!detail || phaseReached < 3}
                  title="Roll back the latest deployment/change (Release Operator), then optionally move the task to a chosen status. Available from UAT onward."
                  onClick={() => setRollbackMenuOpen((open) => !open)}
                  aria-expanded={rollbackMenuOpen}
                >
                  ⤺ Rollback ▾
                </button>
                {rollbackMenuOpen && (
                  <div className="rollback-menu">
                    <button onClick={() => void rollbackRelease()}>Rollback only</button>
                    <hr />
                    {(["planning", "inbox", "blocked", "wont_do"] as const).map((slot) => {
                      const status = boardStatusForSlot(slot, currentWorkspace);
                      return (
                      <button key={slot} onClick={() => void rollbackRelease(status)}>
                        …and Move to {status}
                      </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            </div>
            <div className="conductor-row">
            <div className="review-pingpong" title="Per-step review loop between agents">
              <button
                className={pendingHandoff === "review" ? "review-passed" : ""}
                onClick={() => void sendToReviewer()}
                disabled={!phaseHasIssue}
              >
                Review → A2
              </button>
              <button
                className={pendingHandoff === "findings" ? "needs-fix" : ""}
                onClick={() => void sendFindingsToAuthor()}
                disabled={!phaseHasIssue}
              >
                Findings → A1
              </button>
              <button
                onClick={() => void updateTaskFromAgent1()}
                disabled={!phaseHasIssue}
                title="Append Agent 1's latest conclusions to the task body (only Agent 1 edits the body)"
              >
                Update task ← A1
              </button>
              <button
                onClick={() => void nudgeAgentSignal()}
                disabled={!phaseHasIssue}
                title="The agent finished its step but the loop didn't advance? Ask it to write its signal file now."
              >
                ⚑ Signal?
              </button>
            </div>
            <div className="automation-segment compact" role="tablist" aria-label="Automation level">
              {(["manual", "auto"] as const).map((level) => (
                <button key={level} className={automationLevel === level ? "active" : ""} onClick={() => void updateAutomationLevel(level)}>
                  {level}
                </button>
              ))}
            </div>
            <div className="more-actions-wrap">
              <button className="more-actions-button" onClick={() => setMoreActionsOpen((open) => !open)} aria-expanded={moreActionsOpen}>
                More ▾
              </button>
              {moreActionsOpen && (
                <>
                  <button className="more-actions-scrim" aria-label="Close menu" onClick={() => setMoreActionsOpen(false)} />
                  <div className="more-actions-menu">
                    <button
                      className="report-bug-item"
                      onClick={reportBugActive}
                      disabled={!isBoardSession(detail)}
                    >
                      🐞 Report Bug
                    </button>
                    <hr />
                    <button
                      onClick={() => {
                        setMoreActionsOpen(false);
                        setAttachIssueModal({
                          ref: activeSession?.repo && activeSession.issueNumber ? `${activeSession.repo}#${activeSession.issueNumber}` : "",
                          continueToReview: false
                        });
                      }}
                      disabled={!detail}
                    >
                      Attach issue
                    </button>
                    <button
                      onClick={() => { setMoreActionsOpen(false); void syncGithub(); }}
                      disabled={!detail?.session.repo || !detail.session.issueNumber}
                    >
                      Sync GitHub
                    </button>
                  </div>
                </>
              )}
            </div>
            </div>
          </div>
        </section>

        {workflowWarnings.length > 0 && (
          <section className="warning-banner">
            {workflowWarnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
            <button onClick={() => setWorkflowWarnings([])}>Dismiss</button>
          </section>
        )}

        {errorNotice && (
          <section className="error-banner">
            <p>{errorNotice}</p>
            <button onClick={() => setErrorNotice(null)}>Dismiss</button>
          </section>
        )}

        <section className={`main-grid ${contextOpen ? "with-context" : "no-context"}`}>
          <div className="center-stack">
            {restoreState && (
              <section className="restore-banner">
                <div>
                  <span className="eyebrow">Session restore</span>
                  <strong>{restoreState.label} was active before Twindem closed</strong>
                  <p>{restoreState.description}</p>
                </div>
                <button className="primary" onClick={() => void resumeAgent(restoreState.side)}>
                  Resume {restoreState.label}
                </button>
                <button onClick={() => void startAgent(restoreState.side)}>
                  Start fresh
                </button>
              </section>
            )}
            {showWelcome && sessionWelcome && (
              <section className="restore-banner">
                <div>
                  <span className="eyebrow">Step: {sessionWelcome.stepLabel}</span>
                  <strong>{sessionWelcome.issueTitle ?? "Session ready"}</strong>
                </div>
                {sessionWelcome.canResume && (
                  <button className="primary" onClick={() => {
                    setWelcomeDismissed(detail?.session.id ?? null);
                    void resumeAgent(sessionWelcome.activeSide);
                    const otherSide: AgentSide = sessionWelcome.activeSide === "L" ? "R" : "L";
                    void startAgent(otherSide);
                  }}>
                    Resume
                  </button>
                )}
                <button onClick={() => {
                  setWelcomeDismissed(detail?.session.id ?? null);
                  void startAgent("L");
                  void startAgent("R");
                }}>
                  Start fresh
                </button>
                <button onClick={() => {
                  setWelcomeDismissed(detail?.session.id ?? null);
                }}>
                  Dismiss
                </button>
              </section>
            )}
            <div className={`pane-grid ${paneView}`}>
              {paneView === "tabs" && (
                <div className="pane-tabs" role="tablist" aria-label="Agents">
                  {(["L", "R"] as const).map((side) => {
                    const p = panes[side];
                    const isActive = activeTab === side;
                    const hasTurn = turnIndicator.kind === "agent" && turnIndicator.side === side;
                    return (
                      <button
                        key={side}
                        role="tab"
                        aria-selected={isActive}
                        className={`pane-tab ${isActive ? "active" : ""} ${hasTurn ? "has-turn" : ""}`}
                        onClick={() => setActiveTab(side)}
                      >
                        <span className={`tab-dot ${p.status}`} />
                        <span className="tab-name">{side === "L" ? "Agent 1" : "Agent 2"}</span>
                        <span className="tab-model">{agentDisplayName(config, p.provider, side)}</span>
                        {hasTurn && <span className="tab-turn">turn</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className={`pane-slot ${paneView === "tabs" && activeTab !== "L" ? "hidden" : ""}`}>
                <AgentPane
                  pane={panes.L}
                  config={config}
                  sessionId={detail?.session.id}
                  turnIndicator={turnIndicator}
                  canResume={detail ? canResumeAgent(detail, "L") : false}
                  onChange={(patch) => void updatePane("L", patch)}
                  onStart={() => void startAgent("L")}
                  onResume={() => void resumeAgent("L")}
                  onStop={() => void stopAgent("L")}
                  onUnmute={() => setPanes((prev) => ({ ...prev, L: { ...prev.L, status: "running" } }))}
                  onRestartHandoff={() => void restartAgentWithHandoff("L")}
                />
              </div>
              <div className={`pane-slot ${paneView === "tabs" && activeTab !== "R" ? "hidden" : ""}`}>
                <AgentPane
                  pane={panes.R}
                  config={config}
                  sessionId={detail?.session.id}
                  turnIndicator={turnIndicator}
                  locked={!isBoardSession(detail)}
                  lockedReason="Create the task first"
                  canResume={detail ? canResumeAgent(detail, "R") : false}
                  onChange={(patch) => void updatePane("R", patch)}
                  onStart={() => void startAgent("R")}
                  onResume={() => void resumeAgent("R")}
                  onStop={() => void stopAgent("R")}
                  onUnmute={() => setPanes((prev) => ({ ...prev, R: { ...prev.R, status: "running" } }))}
                  onRestartHandoff={() => void restartAgentWithHandoff("R")}
                />
              </div>
            </div>

            {handoff && (
              <section className="handoff-card">
                <div>
                  <span className="eyebrow">Briefing ready</span>
                  <h3>
                    {handoff.fromRole} → {handoff.toRole}
                  </h3>
                  <p>{handoff.summary}</p>
                  <div className="handoff-evidence">
                    {handoff.evidence.slice(0, 4).map((item) => (
                      <span key={item.key}>{item.label}</span>
                    ))}
                  </div>
                  <small>
                    Round {handoff.roundN}/{handoff.roundTotal} · {handoff.evidence.length} evidence items attached
                  </small>
                </div>
                <button className="primary" onClick={() => void approveHandoff()}>
                  Approve & send
                </button>
              </section>
            )}
          </div>

          {contextOpen && (
          <aside className="evidence">
            {detail && (
              <>
                <BriefPanel detail={detail} workspace={currentWorkspace} />
                <GovernancePanel detail={detail} workspace={currentWorkspace} />
                <CompactEvidencePanel records={detail.evidenceRecords ?? []} />
                <DecisionEvidencePanel records={detail.evidenceRecords ?? []} />
                <CostSummaryPanel detail={detail} />
              </>
            )}
            <section className="context-conductor">
              <h3>Workflow</h3>
              <div className="native-flow-map">
                {groupFlowByStatus(NATIVE_FLOW_STEPS).map(([status, steps]) => {
                  const currentIndex = Math.max(0, NATIVE_FLOW_STEPS.findIndex((s) => s.id === conductorState.currentStepId));
                  return (
                    <div className="flow-status-group" key={status}>
                      <span>{boardStatusForSlot(status, currentWorkspace)}</span>
                      {steps.map((step) => {
                        const index = NATIVE_FLOW_STEPS.findIndex((candidate) => candidate.id === step.id);
                        return (
                          <div
                            key={step.id}
                            className={`flow-step ${step.kind} ${step.id === conductorState.currentStepId ? "current" : ""} ${index < currentIndex ? "done" : ""}`}
                          >
                            <strong>{step.title}</strong>
                            <small>{step.stopMarker ? `stop: ${step.stopMarker}` : step.subtitle}</small>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </section>
            {detail?.github && (
              <>
                <ProjectFieldsPanel github={detail.github} />
                <IssueViewer
                  github={detail.github}
                  onEditBody={() =>
                    setIssueEditModal({
                      mode: "body",
                      title: "Edit issue body",
                      body: detail.github?.body ?? ""
                    })
                  }
                  onComment={() =>
                    setIssueEditModal({
                      mode: "comment",
                      title: "Post issue comment",
                      body: "\n\n---\nAuthor: Twindem\nRole: Workflow"
                    })
                  }
                />
              </>
            )}
            <DeployRunnerPanel detail={detail} config={config} onRun={() => void runDeployAttempt()} />
            <section>
              <h3>Evidence checklist</h3>
              <p>
                {evidenceDone}/{detail?.evidence.length ?? 0} complete
              </p>
              <EvidenceList items={detail?.evidence ?? []} onUpdate={(key, status) => void updateEvidenceStatus(key, status)} />
            </section>
            <section>
              <h3>Audit trail</h3>
              <div className="audit-list">
                {(detail?.workflowEvents ?? []).map((event) => (
                  <div key={event.id} className="audit-row">
                    <strong>{event.action}</strong>
                    <small>
                      {event.result} · {formatTime(event.createdAt)}
                    </small>
                  </div>
                ))}
              </div>
            </section>
            {detail && <RawRefsPanel detail={detail} workspace={currentWorkspace} />}
          </aside>
          )}
        </section>
        </>
        ) : (
          <div className="empty-workspace">
            <h3>No session selected</h3>
            <p>Start a New Session or choose an existing session.</p>
            <div className="empty-workspace-actions">
              <button className="primary" onClick={() => setNewSessionOpen(true)}>New session</button>
              <button onClick={() => void openBoardModal()}>▦ Show board</button>
            </div>
          </div>
        )}
      </section>

      {newSessionOpen && config && (
        <NewSessionDialog
          config={config}
          bugParent={bugParent}
          onCancel={() => {
            setNewSessionOpen(false);
            setBugParent(null);
          }}
          onCreate={createSession}
        />
      )}
      {sessionPreviewModal && config && (
        <SessionPreviewDialog
          detail={sessionPreviewModal.detail}
          config={config}
          onCancel={() => setSessionPreviewModal(null)}
          onEdit={() => openSessionEditFromDetail(sessionPreviewModal.detail)}
          onStart={() => {
            const target = sessionPreviewModal.detail;
            setSessionPreviewModal(null);
            void activateSessionWithCatchup(target, { forceBriefing: true });
          }}
          onStartRefinement={() => {
            const target = sessionPreviewModal.detail;
            setSessionPreviewModal(null);
            void startRefinement(target);
          }}
          onStatusChange={(slot) => void updatePreviewBoardStatus(sessionPreviewModal.detail, slot)}
        />
      )}
      {aboutOpen && <AboutDialog version={appVersion} onClose={() => setAboutOpen(false)} />}
      {folderTrustModal && (
        <FolderTrustDialog
          side={folderTrustModal.side}
          onCancel={() => {
            folderTrustResolver.current?.(false);
            folderTrustResolver.current = null;
            setFolderTrustModal(null);
          }}
          onApproved={() => {
            folderTrustResolver.current?.(true);
          }}
        />
      )}
      {taskProposalModal && (
        <TaskProposalDialog
          modal={taskProposalModal}
          onChange={(tasks) => setTaskProposalModal((current) => (current ? { ...current, tasks } : current))}
          onCancel={() => setTaskProposalModal(null)}
          onCreate={() => void createSelectedFollowUpTasks()}
        />
      )}
      {createTaskOpen && config && detail && (
        <CreateTaskDialog
          config={config}
          detail={detail}
          busy={creatingTask}
          onCancel={() => {
            setCreateTaskOpen(false);
            // Cancelling must not eat Agent 1's NEXT create/idea signal — the dedup keys exist
            // only to stop the dialog reopening while it's already on screen.
            const sid = detailRef.current?.session.id;
            if (sid) {
              handledMarkers.current.delete(`${sid}:task:create`);
              handledMarkers.current.delete(`${sid}:done:idea`);
            }
          }}
          onCreate={(repo, title) => void createTask({ repo, title })}
        />
      )}
      {creatingTask && !createTaskOpen && (
        <div className="modal-backdrop">
          <section className="create-progress-modal">
            <strong>Creating the task on the board…</strong>
            <div className="create-progress-bar"><i /></div>
            <span>Creating board item · setting Inbox</span>
          </section>
        </div>
      )}
      {switchingAgent && (
        <div className="modal-backdrop">
          <section className="create-progress-modal">
            <strong>Switching to {switchingAgent === "L" ? "Agent 1" : "Agent 2"}…</strong>
            <div className="create-progress-bar"><i /></div>
            <span>Starting the agent · waiting for it to be ready · sending the briefing</span>
            <button className="switch-cancel" onClick={cancelSwitch}>
              Cancel — keep working with the current agent
            </button>
          </section>
        </div>
      )}
      {openingArtifact && (
        <div className="modal-backdrop">
          <section className="session-loading-card">
            <TwindemLoader size={52} />
            <strong>Opening {openingArtifact}…</strong>
            <span>Fetching the task, comments and board status. This can take a few seconds.</span>
          </section>
        </div>
      )}
      {onboardingOpen && config && (
        <OnboardingDialog
          config={config}
          mode={onboardingMode}
          onCancel={needsOnboarding(config) ? undefined : () => setOnboardingOpen(false)}
          onSave={saveOnboarding}
        />
      )}
      {boardModalOpen && (
        <BoardViewModal
          artifacts={boardArtifacts}
          workspace={currentWorkspace}
          loading={boardLoading}
          error={boardError}
          syncedAt={boardSyncedAt}
          sessions={sessions}
          activeSessionId={activeSession?.id}
          ownerLabel={
            config
              ? (() => {
                  const ws = activeWorkspace(config, activeSession?.workspaceName);
                  const provider = boardProviderForWorkspace(config, ws);
                  if (provider === "jira") return ws?.jiraProjectKey ? `Jira · ${ws.jiraProjectKey}` : "Jira";
                  return ws?.githubOwner && ws.projectNumber ? `${ws.githubOwner} · Project #${ws.projectNumber}` : "Board";
                })()
              : "Board"
          }
          onRefresh={() => void refreshBoardModal()}
          onOpenArtifact={(artifact) => void openBoardArtifact(artifact)}
          onClose={() => setBoardModalOpen(false)}
          onDismissError={() => setBoardError(null)}
        />
      )}
      {settingsOpen && config && (
        <SettingsDialog
          config={config}
          githubAuthStatus={githubAuthStatus}
          githubAuthChecking={githubAuthChecking}
          onCheckGithub={connectGithubAuth}
          onCancel={() => setSettingsOpen(false)}
          onSave={saveSettings}
          onProjectDeleted={async (deletedName, deletedSessions) => {
            setSettingsOpen(false);
            await handleProjectDeleted(deletedName, deletedSessions);
          }}
        />
      )}
      {projectsOpen && config && (
        <ProjectsDialog
          config={config}
          sessions={sessions}
          activeWorkspaceName={config.defaults.workspaceName}
          onClose={() => setProjectsOpen(false)}
          onSetActive={(name) => void switchActiveProject(name)}
          onDeleted={async (deletedName, deletedSessions, sourceFolderDeleted, sourceFolderDeleteError) => {
            await handleProjectDeleted(deletedName, deletedSessions, sourceFolderDeleted);
            if (sourceFolderDeleteError) setErrorNotice(`Project deleted, but source folder removal failed: ${sourceFolderDeleteError}`);
          }}
        />
      )}
      {workflowModal && (
        <WorkflowConfirmDialog
          modal={workflowModal}
          onBodyChange={(body) => setWorkflowModal((prev) => (prev ? { ...prev, body } : prev))}
          onCancel={() => setWorkflowModal(null)}
          onConfirm={() => void confirmWorkflowAction()}
        />
      )}
      {evidenceModal && (
        <EvidenceReasonDialog
          modal={evidenceModal}
          onReasonChange={(reason) => setEvidenceModal((prev) => (prev ? { ...prev, reason } : prev))}
          onCancel={() => setEvidenceModal(null)}
          onConfirm={() => void confirmEvidenceStatus()}
        />
      )}
      {attachIssueModal && (
        <AttachIssueDialog
          modal={attachIssueModal}
          workspace={config ? activeWorkspace(config, detail?.session.workspaceName) : undefined}
          onRefChange={(ref) => setAttachIssueModal((prev) => (prev ? { ...prev, ref } : prev))}
          onCancel={() => setAttachIssueModal(null)}
          onConfirm={() => void attachIssue(attachIssueModal.ref, attachIssueModal.continueToReview)}
          onSelect={(artifact) => void attachIssue(`${artifact.repo}#${artifact.issueNumber}`, attachIssueModal.continueToReview)}
        />
      )}
      {issueEditModal && (
        <IssueEditDialog
          modal={issueEditModal}
          onBodyChange={(body) => setIssueEditModal((prev) => (prev ? { ...prev, body } : prev))}
          onCancel={() => setIssueEditModal(null)}
          onConfirm={() => void confirmIssueEdit()}
        />
      )}
      {sessionEditModal && (
        <SessionEditDialog
          modal={sessionEditModal}
          onChange={(patch) => setSessionEditModal((prev) => (prev ? { ...prev, ...patch } : prev))}
          onCancel={() => setSessionEditModal(null)}
          onConfirm={() => void updateSessionDetails(sessionEditModal)}
        />
      )}
      {deleteSessionModal && (
        <DeleteSessionDialog
          modal={deleteSessionModal}
          busy={deletingSession}
          onChange={(patch) => setDeleteSessionModal((prev) => (prev ? { ...prev, ...patch } : prev))}
          onCancel={() => setDeleteSessionModal(null)}
          onConfirm={() => void confirmDeleteSession()}
        />
      )}
      {nativeGateModal && config && (
        <NativeGateDialog
          modal={nativeGateModal}
          config={config}
          onChange={setNativeGateModal}
          onCancel={() => setNativeGateModal(null)}
          onConfirm={() => void confirmNativeGate()}
        />
      )}
      {uatFindingModal && (
        <div className="modal-backdrop">
          <section className="workflow-confirm">
            <header>
              <div>
                <span className="eyebrow">UAT finding</span>
                <h2>Report a UAT issue</h2>
              </div>
              <button onClick={() => setUatFindingModal(null)}>Close</button>
            </header>
            <p>Describe what failed in UAT. It's posted as a comment on this task (kept on the same issue).</p>
            <textarea
              rows={5}
              autoFocus
              placeholder="e.g. The 30-day chart shows yesterday's data; the dropdown doesn't refresh the chart on UAT."
              value={uatFindingModal.text}
              onChange={(event) => setUatFindingModal((m) => (m ? { ...m, text: event.target.value } : m))}
            />
            <label className="quick-note-toggle">
              <input
                type="checkbox"
                checked={uatFindingModal.sendBack}
                onChange={(event) => setUatFindingModal((m) => (m ? { ...m, sendBack: event.target.checked } : m))}
              />
              <span>Send the task back to <strong>In Progress</strong> for Agent 1 to fix it now.</span>
            </label>
            <footer>
              <button onClick={() => setUatFindingModal(null)}>Cancel</button>
              <button className="primary" onClick={() => void submitUatFinding()} disabled={!uatFindingModal.text.trim()}>
                {uatFindingModal.sendBack ? "Post & send back to fix" : "Post comment"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {skipPhaseConfirm && (
        <div className="modal-backdrop">
          <section className="workflow-confirm">
            <header>
              <div>
                <span className="eyebrow">Skip steps?</span>
                <h2>Jump to {skipPhaseConfirm.targetLabel}?</h2>
              </div>
            </header>
            <p>
              This skips: <strong>{skipPhaseConfirm.skipped.join(", ")}</strong>. Those steps carry the
              plan/review work for this task — moving straight to {skipPhaseConfirm.targetLabel} skips them.
            </p>
            <footer>
              <button onClick={() => setSkipPhaseConfirm(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  const target = skipPhaseConfirm.targetKey;
                  setSkipPhaseConfirm(null);
                  void goToPhase(target, true);
                }}
              >
                Skip to {skipPhaseConfirm.targetLabel}
              </button>
            </footer>
          </section>
        </div>
      )}
      {notice && <div className="toast">{notice}</div>}
    </main>
  );
}

function BoardStatusBar({
  detail,
  workspace,
  onSync,
  onStatusChange,
  onLinkIssue
}: {
  detail: SessionDetail | null;
  workspace?: TandemConfig["workspaces"][number];
  onSync: () => void;
  onStatusChange: (status: string) => void;
  onLinkIssue: () => void;
}) {
  const status = boardStatusForDetail(detail, workspace);
  const baseStatuses = boardStatusOptions(workspace);
  const statusText = statusTextForIdeaType(detail?.session.ideaType);
  const statuses = baseStatuses.some((item) => item.label === status.label)
    ? baseStatuses
    : [...baseStatuses, { slot: status.slot ?? "inbox", label: status.label, phase: status.phase }];

  const hasBoardArtifact = hasBoardArtifactSession(detail?.session);
  const canSyncIssue = Boolean(detail?.session.repo && detail?.session.issueNumber);

  if (!hasBoardArtifact) {
    return (
      <section className="board-status-bar unlinked">
        <div className="board-unlinked-icon">#</div>
        <div>
          <strong>Local idea - no board item linked</strong>
          <p>Create or attach a board task before Twindem can sync board status.</p>
        </div>
        <span className="board-phase-pill">Twindem {phaseLabelForVisiblePhase(detail?.session.visiblePhase)}</span>
        <button className="primary" onClick={onLinkIssue} disabled={!detail}>
          Attach issue
        </button>
      </section>
    );
  }

  return (
    <section className={`board-status-bar ${status.syncState}`}>
      <div className="board-track" aria-label="Board status">
        {statuses.map((item, index) => ({ ...item, index }))
          .filter((item) => MAIN_TRACK_STATUS_SLOTS.has(item.slot) || item.slot === status.slot)
          .map((item) => {
            const state = item.index < status.index ? "done" : item.index === status.index ? "active" : "todo";
            return (
              <div key={item.label} className={`board-step ${state}`}>
                <span className="board-dot">{state === "done" ? "✓" : ""}</span>
                <span>{statusText[item.slot] ?? item.label}</span>
              </div>
            );
          })}
      </div>
      <div className="board-meta">
        <span className="board-source">Board status</span>
        <label className="board-status-picker">
          <span className="sr-only">Board status</span>
          <select value={status.label} onChange={(event) => onStatusChange(event.target.value)}>
            {statuses.map((item) => (
              <option key={item.label} value={item.label}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <span className="board-phase-pill">Twindem {statusText[status.slot ?? "inbox"] ?? status.phase}</span>
        <span className={`board-sync ${status.syncState}`}>{status.syncLabel}</span>
        <button onClick={onSync} disabled={!canSyncIssue} title={canSyncIssue ? "Sync issue from GitHub" : "Project draft items do not have issue details to sync yet"}>
          Sync board
        </button>
      </div>
    </section>
  );
}

function ProjectFieldsPanel({ github }: { github: GitHubIssueContext }) {
  const rows = projectFieldRows(github);
  return (
    <section>
      <h3>Project fields</h3>
      <div className="project-fields-panel">
        {rows.map((row) => (
          <div key={row.name} className={row.source === "fallback" ? "field-row fallback" : "field-row"}>
            <span>{row.name}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function IssueViewer({
  github,
  onEditBody,
  onComment
}: {
  github: GitHubIssueContext;
  onEditBody: () => void;
  onComment: () => void;
}) {
  return (
    <section>
      <h3>Issue viewer</h3>
      <div className="issue-viewer">
        <div className="issue-viewer-head">
          <div>
            <strong>{github.title}</strong>
            <small>
              {github.repo}#{github.issueNumber} · synced {formatTime(github.fetchedAt)}
            </small>
          </div>
          <div className="inline-actions compact">
            <button onClick={onEditBody}>Edit body</button>
            <button onClick={onComment}>Comment</button>
            <a href={github.url}>Open</a>
          </div>
        </div>
        <div className="label-row">
          {github.labels.slice(0, 10).map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <article className="issue-body-preview">
          {compactMarkdown(github.body, 900) || "No issue body yet."}
        </article>
        {(github.linkedPrs ?? []).length > 0 && (
          <div className="linked-prs">
            {(github.linkedPrs ?? []).map((pr) => (
              <a key={pr.url} href={pr.url}>
                PR #{pr.number} · {pr.state}
              </a>
            ))}
          </div>
        )}
        <div className="issue-comments">
          {github.comments.slice(-4).map((comment) => (
            <div key={`${comment.author}-${comment.createdAt}`} className="issue-comment">
              <strong>{comment.author}</strong>
              <small>{formatTime(comment.createdAt)}</small>
              <p>{compactMarkdown(comment.body, 220)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DeployRunnerPanel({
  detail,
  config,
  onRun
}: {
  detail: SessionDetail | null;
  config: TandemConfig | null;
  onRun: () => void;
}) {
  const workspace = detail && config ? activeWorkspace(config, detail.session.workspaceName) : config ? activeWorkspace(config) : undefined;
  const command = workspace?.uatDeployCommand?.trim();
  const args = workspace?.uatDeployArgs ?? [];
  const attempts = detail?.deployAttempts ?? [];
  return (
    <section>
      <div className="section-title-row">
        <h3>Deploy runner</h3>
        <button className="primary" onClick={onRun} disabled={!detail || !command}>
          Run UAT
        </button>
      </div>
      <div className="deploy-runner-panel">
        <div className="deploy-command">
          <span>Configured command</span>
          <code>{command ? [command, ...args].join(" ") : "No UAT command configured"}</code>
        </div>
        <div className="deploy-attempts">
          {attempts.length > 0 ? (
            attempts.slice(0, 5).map((attempt) => (
              <article key={attempt.id} className={`deploy-attempt ${attempt.status}`}>
                <div>
                  <strong>{attempt.status}</strong>
                  <small>
                    {formatTime(attempt.startedAt)}
                    {attempt.endedAt ? ` -> ${formatTime(attempt.endedAt)}` : ""}
                  </small>
                </div>
                <code>{[attempt.command, ...attempt.args].join(" ")}</code>
                {attempt.output && <pre>{compactUiText(attempt.output, 700)}</pre>}
                {attempt.error && <p>{compactUiText(attempt.error, 360)}</p>}
              </article>
            ))
          ) : (
            <div className="empty-panel">No deploy attempts yet.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function AgentPane({
  pane,
  config,
  sessionId,
  turnIndicator,
  canResume,
  locked,
  lockedReason,
  onChange,
  onStart,
  onResume,
  onStop,
  onUnmute,
  onRestartHandoff
}: {
  pane: PaneState;
  config: TandemConfig | null;
  sessionId?: string;
  turnIndicator: TurnIndicator;
  canResume: boolean;
  locked?: boolean;
  lockedReason?: string;
  onChange: (patch: Partial<PaneState>) => void;
  onStart: () => void;
  onResume: () => void;
  onStop: () => void;
  onUnmute: () => void;
  onRestartHandoff: () => void;
}) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const statusRef = useRef(pane.status);
  const turnState = turnIndicator.kind === "agent" && turnIndicator.side === pane.side ? "active" : "standby";
  const turnLabel = turnState === "active" ? "Has turn" : turnIndicator.kind === "human" ? "Human gate" : "Standby";

  useEffect(() => {
    statusRef.current = pane.status;
  }, [pane.status]);

  // Live ref so the terminal data listener (registered once per side) can filter out output that
  // belongs to a previous session's still-running agent instead of mixing it into this session.
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);


  useEffect(() => {
    if (!terminalRef.current) return undefined;
    let resizeTimer = 0;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: 12,
      lineHeight: 1.25,
      // Personalized warm theme (not stark white-on-black).
      theme: {
        background: "#1b1d22",
        foreground: "#e7e4da",
        cursor: "#3b8bff",
        cursorAccent: "#1b1d22",
        selectionBackground: "rgba(59,139,255,0.28)",
        black: "#2a2c31",
        red: "#e06c63",
        green: "#54b487",
        yellow: "#d6a44e",
        blue: "#3b8bff",
        magenta: "#a98ae6",
        cyan: "#46b0b0",
        white: "#e7e4da",
        brightBlack: "#7e818a",
        brightWhite: "#fbfaf6"
      }
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    terminal.current = term;
    fit.current = fitAddon;
    term.writeln(`\x1b[2m${pane.side === "L" ? "Agent 1" : "Agent 2"} terminal — start or resume the agent to begin.\x1b[0m`);

    term.onData((data) => {
      if (statusRef.current === "muted") {
        term.writeln("\r\n[Twindem] input is muted for this pane. Unmute before typing.\r\n");
        return;
      }
      void window.tandem.agents.write(pane.side, data).then((result) => {
        if (!result.ok) term.writeln(`\r\n[Twindem] ${result.error.message}\r\n`);
      });
    });

    const isCurrentSession = (payloadSessionId?: string) =>
      !payloadSessionId || !sessionIdRef.current || payloadSessionId === sessionIdRef.current;
    const offData = window.tandem.agents.onData((payload) => {
      if (payload.side === pane.side && isCurrentSession(payload.sessionId)) term.write(payload.data);
    });
    const offExit = window.tandem.agents.onExit((payload) => {
      if (payload.side === pane.side && isCurrentSession(payload.sessionId)) {
        term.writeln(`\r\n[Twindem] process exited ${payload.exitCode}\r\n`);
      }
    });
    const resizeObserver = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fitAddon.fit();
        void window.tandem.agents.resize(pane.side, term.cols, term.rows);
      }, 100);
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      offData();
      offExit();
      resizeObserver.disconnect();
      window.clearTimeout(resizeTimer);
      term.dispose();
    };
  }, [pane.side]);

  // When the session changes, reset the terminal to a clean placeholder. We intentionally do NOT
  // replay persisted PTY: it is stored sliced/trimmed, which breaks ANSI and renders as garbage.
  // Live output streams faithfully while the agent runs; durable history needs stream-json.
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.reset();
    {
      term.writeln(`[2m${pane.side === "L" ? "Agent 1" : "Agent 2"} terminal — start the agent to begin.[0m`);
    }
  }, [sessionId, pane.side]);

  return (
    <section className={`agent-pane turn-${turnState}`}>
      <header>
        <div>
          <span className="eyebrow">{pane.side === "L" ? "Agent 1" : "Agent 2"}</span>
          <h3>{agentDisplayName(config, pane.provider, pane.side)}</h3>
          <p className="agent-profile-line">{roleLabel(pane.roles)}</p>
        </div>
        <div className="agent-header-actions">
          <span className={`turn-light ${turnState}`}>
            <i />
            {turnLabel}
          </span>
          {pane.status === "running" && <AgentWorkingIndicator />}
          <span className={`agent-status ${pane.status}`}>{pane.status}</span>
        </div>
      </header>
      <div className="pane-controls">
        <RoleChecklist
          title="Roles"
          roles={pane.roles}
          allRoles={Object.keys(config?.roles ?? {})}
          onChange={(roles) => onChange({ roles })}
        />
        <label>
          Model
          <select
            className="agent-profile-select"
            value={pane.provider}
            onChange={(event) => onChange({ provider: event.target.value })}
          >
            {providerGroups(config, pane.provider).map(([group, entries]) => (
              <optgroup key={group} label={group}>
                {entries.map(([key, provider]) => (
                  <option key={key} value={key}>
                    {providerOptionLabel(key, provider)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {locked && pane.status !== "running" ? (
          <span className="agent-locked-note" title={lockedReason}>
            🔒 {lockedReason ?? "Locked"}
          </span>
        ) : pane.status === "muted" ? (
          <button className="primary" onClick={onUnmute}>
            Unmute input
          </button>
        ) : pane.status === "running" ? (
          <div className="inline-actions compact">
            <button
              onClick={onRestartHandoff}
              title="Restart the agent fresh and re-seed it from the compact handoff (decisions, constraints, open findings) — cuts context volume without losing state."
            >
              ⟳ Compact restart
            </button>
            <button onClick={onStop}>Stop</button>
          </div>
        ) : (
          <div className="inline-actions compact">
            {canResume && <button onClick={onResume}>Resume</button>}
            <button className="primary" onClick={onStart}>
              Start
            </button>
          </div>
        )}
      </div>
      {/* Card strip removed by user request: the legacy result cards (echo-scraped TWINDEM_RESULT
          blocks) kept reappearing and shrank the terminal. The terminal IS the live view. */}
      <div className="terminal-host main" ref={terminalRef} />
    </section>
  );
}

// Official animated loader (the Twindem mark, top/bottom halves fading between blue shades).
// Inlined so the CSS animation runs (an <img>-loaded SVG wouldn't animate); the keyframes live in
// App.css under .twindem-loader.
function TwindemLoader({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <svg className={`twindem-loader ${className ?? ""}`} width={size} height={size} viewBox="0 0 512 512" role="img" aria-label="Loading">
      <g transform="translate(256 250)">
        <path className="top" d="M-160 -90 H-47 C-20 -90 -4 -73 -4 -47 V52 L-34 30 V-30 C-34 -45 -45 -56 -60 -56 H-145 C-158 -56 -166 -67 -170 -90 Z" />
        <path className="top" d="M160 -90 H47 C20 -90 4 -73 4 -47 V52 L34 30 V-30 C34 -45 45 -56 60 -56 H145 C158 -56 166 -67 170 -90 Z" />
        <path className="bottom" d="M-100 -30 H-58 L-54 10 H-88 C-104 10 -112 25 -104 43 C-88 78 -58 105 -20 132 V170 C-80 133 -127 88 -146 35 C-158 0 -140 -30 -100 -30 Z" />
        <path className="bottom" d="M100 -30 H58 L54 10 H88 C104 10 112 25 104 43 C88 78 58 105 20 132 V170 C80 133 127 88 146 35 C158 0 140 -30 100 -30 Z" />
      </g>
    </svg>
  );
}

function AgentWorkingIndicator() {
  return (
    <div className="agent-working" aria-label="Agent is working">
      <span />
      <span />
      <span />
    </div>
  );
}


function EvidenceList({
  items,
  onUpdate
}: {
  items: EvidenceItem[];
  onUpdate: (key: string, status: EvidenceStatus) => void;
}) {
  return (
    <div className="evidence-list">
      {items.map((item) => (
        <div key={item.id} className={`evidence-item ${item.status}`}>
          <span />
          <div>
            <strong>{item.title}</strong>
            <small>{item.status}</small>
            <div className="evidence-actions">
              <button onClick={() => onUpdate(item.key, "done")} disabled={item.status === "done"}>
                Done
              </button>
              <button onClick={() => onUpdate(item.key, "na")} disabled={item.status === "na"}>
                N/A
              </button>
              <button onClick={() => onUpdate(item.key, "blocked")} disabled={item.status === "blocked"}>
                Block
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RoleChecklist({
  title,
  roles,
  allRoles,
  allowEmpty = false,
  onChange
}: {
  title: string;
  roles: string[];
  allRoles: string[];
  allowEmpty?: boolean;
  onChange: (roles: string[]) => void;
}) {
  const fallback = allRoles[0] ? [allRoles[0]] : ["Agent"];
  const normalized = allowEmpty ? uniqueAllowedRoles(roles, allRoles) : normalizeRoles(roles, fallback);

  function toggle(role: string) {
    const next = normalized.includes(role)
      ? normalized.filter((candidate) => candidate !== role)
      : [...normalized, role];
    onChange(allowEmpty ? uniqueAllowedRoles(next, allRoles) : normalizeRoles(next, fallback));
  }

  return (
    <fieldset className="role-checklist">
      <legend>{title}</legend>
      <div>
        {allRoles.map((role) => (
          <label key={role} className="role-check">
            <input
              type="checkbox"
              checked={normalized.includes(role)}
              onChange={() => toggle(role)}
            />
            <span>{role}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}



function BoardViewModal({
  artifacts,
  workspace,
  loading,
  error,
  syncedAt,
  sessions,
  activeSessionId,
  ownerLabel,
  onRefresh,
  onOpenArtifact,
  onClose,
  onDismissError
}: {
  artifacts: BoardArtifactOption[];
  workspace?: TandemConfig["workspaces"][number];
  loading: boolean;
  error: string | null;
  syncedAt: string | null;
  sessions: SessionSummary[];
  activeSessionId?: string;
  ownerLabel: string;
  onRefresh: () => void;
  onOpenArtifact: (artifact: BoardArtifactOption) => void;
  onClose: () => void;
  onDismissError: () => void;
}) {
  // Index sessions by board artifact so each card knows whether it already has a Twindem session
  // (and whether it's the active one).
  const sessionByArtifact = new Map<string, SessionSummary>();
  for (const session of sessions) {
    if (session.repo && session.issueNumber) sessionByArtifact.set(`${session.repo}#${session.issueNumber}`, session);
    if (session.boardItemId) sessionByArtifact.set(session.boardItemId, session);
  }

  const columnsMap = new Map<string, BoardArtifactOption[]>();
  for (const artifact of artifacts) {
    const status = artifact.status?.trim() || "No status";
    const list = columnsMap.get(status) ?? [];
    list.push(artifact);
    columnsMap.set(status, list);
  }
  const columns = Array.from(columnsMap.entries()).sort(
    ([a], [b]) => boardColumnSortKeyForStatus(a, workspace) - boardColumnSortKeyForStatus(b, workspace) || a.localeCompare(b)
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="board-view" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="eyebrow">Board</span>
            <h2>{ownerLabel}</h2>
            <p>
              {artifacts.length} items{syncedAt ? ` · synced ${syncedAt}` : ""}
            </p>
          </div>
          <div className="board-view-actions">
            <button onClick={onRefresh} disabled={loading}>
              {loading ? "Refreshing…" : "⟳ Refresh"}
            </button>
            <button onClick={onClose}>Close</button>
          </div>
        </header>

        {error && (
          <div className="settings-error">
            <span>{error}</span>
            <button onClick={onDismissError}>Dismiss</button>
          </div>
        )}

        {loading && artifacts.length === 0 ? (
          <div className="board-view-loading">
            <TwindemLoader size={56} />
            <span>Loading the board…</span>
          </div>
        ) : columns.length === 0 ? (
          <div className="empty-panel">No items on this board yet.</div>
        ) : (
          <div className="board-columns">
            {columns.map(([status, items]) => {
              const slot = slotForBoardStatus(status, workspace);
              const offTrack = Boolean(slot && !MAIN_TRACK_STATUS_SLOTS.has(slot)) || (!slot && status !== "No status");
              return (
                <div key={status} className={`board-column${offTrack ? " off-track" : ""}`}>
                  <header className="board-column-head">
                    <span>{status}</span>
                    <strong>{items.length}</strong>
                  </header>
                  <div className="board-column-cards">
                    {items.map((artifact) => {
                      const artifactRef = boardArtifactRef(artifact);
                      const session = sessionByArtifact.get(artifactRef) ?? sessionByArtifact.get(artifact.id);
                      const isActive = session && session.id === activeSessionId;
                      const marker = isActive ? "◆" : session ? "◷" : "●";
                      const markerClass = isActive ? "active" : session ? "has-session" : "no-session";
                      return (
                        <button
                          key={artifact.id}
                          className={`board-card${isActive ? " active" : ""}`}
                          title={`${artifactRef} — open in Twindem`}
                          onClick={() => onOpenArtifact(artifact)}
                        >
                          <span className="board-card-title">
                            <span className={`board-card-marker ${markerClass}`}>{marker}</span>
                            <span className="board-card-title-text">{artifact.title}</span>
                          </span>
                          <span className="board-card-meta">
                            {artifactRef}{artifact.type === "Draft" ? " · Project draft item" : ""}
                          </span>
                          {(artifact.labels.length > 0 || isActive) && (
                            <span className="board-card-labels">
                              {isActive && <span className="board-card-active">ACTIVE</span>}
                              {artifact.labels.slice(0, 4).map((label) => (
                                <span key={label} className="board-card-label">
                                  {label}
                                </span>
                              ))}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <footer className="board-view-legend">
          <span><span className="board-card-marker no-session">●</span> no session</span>
          <span><span className="board-card-marker has-session">◷</span> has a Twindem session</span>
          <span><span className="board-card-marker active">◆</span> active session</span>
          <span>Click a card to open it in Twindem.</span>
        </footer>
      </section>
    </div>
  );
}

// Single source of truth for the agent CLIs Twindem supports and the models each one accepts.
// The command and the exact `--model` args are derived from the selection — the user never types
// a command or a model string. Add models here to widen the dropdown everywhere (onboarding +
// Setup). Model args verified: claude --model {opus|sonnet|haiku|<full-id>}; codex --model gpt-5.x
// plus optional -c model_reasoning_effort=low|high (codex-cli 0.139).
type CatalogModel = { id: string; label: string; args: string[] };
type CatalogAgent = { command: string; label: string; models: CatalogModel[] };

const AGENT_CATALOG: CatalogAgent[] = [
  {
    command: "claude",
    label: "Claude Code",
    models: [
      { id: "default", label: "CLI default", args: [] },
      { id: "opus", label: "Opus (latest) — top quality", args: ["--model", "opus"] },
      { id: "claude-opus-4-8", label: "Opus 4.8 — top quality, expensive", args: ["--model", "claude-opus-4-8"] },
      { id: "sonnet", label: "Sonnet (latest) — balanced", args: ["--model", "sonnet"] },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced cost/quality", args: ["--model", "claude-sonnet-4-6"] },
      { id: "haiku", label: "Haiku (latest) — fast & cheap", args: ["--model", "haiku"] },
      { id: "claude-haiku-4-5", label: "Haiku 4.5 — fast & cheapest", args: ["--model", "claude-haiku-4-5-20251001"] }
    ]
  },
  {
    command: "codex",
    label: "Codex",
    models: [
      { id: "default", label: "CLI default", args: [] },
      { id: "gpt-5.5-low", label: "GPT-5.5 low effort — fast & cheap", args: ["--model", "gpt-5.5", "-c", "model_reasoning_effort=low"] },
      { id: "gpt-5.5", label: "GPT-5.5 — balanced", args: ["--model", "gpt-5.5"] },
      { id: "gpt-5.5-high", label: "GPT-5.5 high effort — thorough, pricier", args: ["--model", "gpt-5.5", "-c", "model_reasoning_effort=high"] },
      { id: "gpt-5.4-mini-low", label: "GPT-5.4 mini low effort — cheaper", args: ["--model", "gpt-5.4-mini", "-c", "model_reasoning_effort=low"] },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini — fast", args: ["--model", "gpt-5.4-mini"] },
      { id: "gpt-5.4", label: "GPT-5.4 — balanced previous", args: ["--model", "gpt-5.4"] },
      { id: "gpt-5.1", label: "GPT-5.1 — previous gen", args: ["--model", "gpt-5.1"] }
    ]
  }
];

function catalogAgentFor(command: string): CatalogAgent {
  return AGENT_CATALOG.find((agent) => agent.command === command.trim().toLowerCase()) ?? AGENT_CATALOG[0];
}

// Match the current args string back to a catalog model (so reopening Setup shows the right pick).
function catalogModelFor(agent: CatalogAgent, args: string): CatalogModel {
  const normalized = splitArgs(args).join(" ");
  return agent.models.find((model) => model.args.join(" ") === normalized) ?? agent.models[0];
}

function OnboardingDialog({
  config,
  mode,
  onCancel,
  onSave
}: {
  config: TandemConfig;
  mode: OnboardingMode;
  onCancel?: () => void;
  onSave: (config: TandemConfig) => Promise<void>;
}) {
  const workspace = activeWorkspace(config) ?? config.workspaces[0];
  const newProject = mode === "new-project";
  const sourceLeftPane = workspacePaneDefault(config, "L", workspace?.name);
  const sourceRightPane = workspacePaneDefault(config, "R", workspace?.name);
  const leftProvider = config.providers[sourceLeftPane.provider] ?? config.providers.codex;
  const rightProvider = config.providers[sourceRightPane.provider] ?? config.providers.claude;
  const [workspaceName, setWorkspaceName] = useState(newProject ? uniqueWorkspaceName(config, "New project") : workspace?.name || "Local project");
  const [workspaceRoot, setWorkspaceRoot] = useState(newProject ? "" : workspace?.root || "");
  const [description, setDescription] = useState(newProject ? "" : workspace?.description ?? "");
  const [agentInstructions, setAgentInstructions] = useState(newProject ? "" : workspace?.agentInstructions ?? "");
  const [uatReleaseInstructions, setUatReleaseInstructions] = useState(newProject ? "" : workspace?.uatReleaseInstructions ?? "");
  const [prodReleaseInstructions, setProdReleaseInstructions] = useState(newProject ? "" : workspace?.prodReleaseInstructions ?? "");
  // Honor the explicit saved boardProvider first (shared resolver) so reopening Settings reflects
  // the user's last choice — not residual jiraSiteUrl/githubOwner from a previous provider.
  const resolvedProvider = boardProviderForWorkspace(config, workspace);
  const inferredBoardType: BoardType = resolvedProvider === "github_project" ? "github" : resolvedProvider;
  const [boardType, setBoardType] = useState<BoardType>(newProject ? "github" : inferredBoardType);
  const [boardSetupMode, setBoardSetupMode] = useState<"existing" | "create">("existing");
  const [githubOwner, setGithubOwner] = useState(newProject ? "" : workspace?.githubOwner ?? "");
  const [projectNumber, setProjectNumber] = useState(newProject ? "" : workspace?.projectNumber ? String(workspace.projectNumber) : "");
  const [issueRepository, setIssueRepository] = useState(newProject ? "" : workspace?.issueRepository ?? "");
  const [jiraSiteUrl, setJiraSiteUrl] = useState(newProject ? "" : workspace?.jiraSiteUrl ?? "");
  const [jiraProjectKey, setJiraProjectKey] = useState(newProject ? "" : workspace?.jiraProjectKey ?? "");
  const [jiraBoardId, setJiraBoardId] = useState(newProject ? "" : workspace?.jiraBoardId ?? "");
  const [jiraIssueType, setJiraIssueType] = useState(newProject ? "Task" : workspace?.jiraIssueType ?? "Task");
  const [jiraEmail, setJiraEmail] = useState(newProject ? "" : workspace?.jiraEmail ?? "");
  const [jiraApiToken, setJiraApiToken] = useState("");
  const [jiraCheck, setJiraCheck] = useState<GitHubAuthStatus | null>(null);
  const [jiraProjects, setJiraProjects] = useState<JiraProjectOption[]>([]);
  const [jiraProjectsLoading, setJiraProjectsLoading] = useState(false);
  const [jiraCreating, setJiraCreating] = useState(false);
  const [jiraStatuses, setJiraStatuses] = useState<string[]>([]);
  const [jiraStatusesLoading, setJiraStatusesLoading] = useState(false);
  const [jiraStatusesError, setJiraStatusesError] = useState<string | null>(null);
  const [jiraStatusesUnioned, setJiraStatusesUnioned] = useState(false);
  const [statusMapping, setStatusMapping] = useState<StatusMappingValue>(() => {
    const seed = (newProject ? undefined : workspace?.statusMapping) ?? defaultWorkspaceStatusMapping;
    return { write: { ...seed.write }, read: { ...seed.read }, ignored: [...(seed.ignored ?? [])] };
  });
  const [onboardingAutomation, setOnboardingAutomation] = useState<AutomationLevel>(normalizeAutomation(config.defaults.automationLevel));
  const [allowedRepoPaths, setAllowedRepoPaths] = useState((newProject ? [] : workspace?.allowedRepoPaths ?? []).join("\n"));
  const [projectLayout, setProjectLayout] = useState<ProjectLayoutEntry[]>(newProject ? [] : workspace?.projectLayout ?? []);
  const [principalRepo, setPrincipalRepo] = useState<{ owner: string; name: string } | undefined>(
    newProject ? undefined : workspace?.principalRepo ? { owner: workspace.principalRepo.owner, name: workspace.principalRepo.name } : undefined
  );
  const [newBoardTitle, setNewBoardTitle] = useState(newProject ? workspaceName : workspace?.name || "Twindem delivery");
  const [leftCommand, setLeftCommand] = useState(leftProvider?.command || "codex");
  const [leftArgs, setLeftArgs] = useState((leftProvider?.args ?? []).join(" "));
  const [leftModel, setLeftModel] = useState(leftProvider?.model ?? leftProvider?.version ?? "default");
  const [leftAuthMode, setLeftAuthMode] = useState<AgentAuthMode>(leftProvider?.authMode ?? "subscription");
  const [leftDangerouslySkipPermissions, setLeftDangerouslySkipPermissions] = useState(Boolean(leftProvider?.dangerouslySkipPermissions));
  const [leftApiKey, setLeftApiKey] = useState("");
  const initialRolePartition = completeRolePartition(
    rolesFromPaneDefault(sourceLeftPane, DEFAULT_AGENT_1_ROLES),
    rolesFromPaneDefault(sourceRightPane, DEFAULT_AGENT_2_ROLES),
    Object.keys(config.roles)
  );
  const [leftRoles, setLeftRoles] = useState(initialRolePartition.L);
  const [rightCommand, setRightCommand] = useState(rightProvider?.command || "claude");
  const [rightArgs, setRightArgs] = useState((rightProvider?.args ?? []).join(" "));
  const [rightModel, setRightModel] = useState(rightProvider?.model ?? rightProvider?.version ?? "default");
  const [rightAuthMode, setRightAuthMode] = useState<AgentAuthMode>(rightProvider?.authMode ?? "subscription");
  const [rightDangerouslySkipPermissions, setRightDangerouslySkipPermissions] = useState(Boolean(rightProvider?.dangerouslySkipPermissions));
  const [rightApiKey, setRightApiKey] = useState("");
  const [rightRoles, setRightRoles] = useState(initialRolePartition.R);
  const [leftCheck, setLeftCheck] = useState<CommandCheckResult | null>(null);
  const [rightCheck, setRightCheck] = useState<CommandCheckResult | null>(null);
  const [githubCheck, setGithubCheck] = useState<GitHubAuthStatus | null>(null);
  const [githubProjects, setGithubProjects] = useState<GitHubProjectOption[]>([]);
  const [githubProjectOwners, setGithubProjectOwners] = useState<GitHubProjectOwnerOption[]>([]);
  const [githubProjectsLoading, setGithubProjectsLoading] = useState(false);
  const [githubProjectCreating, setGithubProjectCreating] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [boardHelpTopic, setBoardHelpTopic] = useState<BoardHelpTopic>(null);
  const steps = [
    { key: "project", label: "Project" },
    { key: "context", label: "Context" },
    { key: "agent1", label: "Agent 1" },
    { key: "agent2", label: "Agent 2" },
    { key: "board", label: "Board" },
    { key: "code", label: "Code/Repo" },
    { key: "statuses", label: "Statuses" }
  ] as const;
  const [stepIndex, setStepIndex] = useState(0);
  const currentStep = steps[stepIndex].key;

  // Load the project's real Jira statuses when entering the Statuses step, so the mapping grid is
  // populated and auto-mapped. Only for Jira with a selected project, and only once per project.
  useEffect(() => {
    if (currentStep !== "statuses" || boardType !== "jira") return;
    if (!jiraProjectKey.trim() || !jiraCheck?.ok) return;
    if (jiraStatuses.length > 0 || jiraStatusesLoading) return;
    void loadJiraStatuses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, boardType, jiraProjectKey, jiraCheck?.ok]);

  async function browseWorkspaceRoot() {
    try {
      const picked = await unwrap(window.tandem.config.pickDirectory());
      if (picked) setWorkspaceRoot(picked);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    }
  }

  async function checkCommand(side: AgentSide) {
    const command = side === "L" ? leftCommand : rightCommand;
    const authMode = side === "L" ? leftAuthMode : rightAuthMode;
    const apiKey = side === "L" ? leftApiKey : rightApiKey;
    setChecking(side);
    try {
      const result = await unwrap(window.tandem.system.checkCommand(command));
      if (side === "L") setLeftCheck(result);
      else setRightCheck(result);
      if (result.ok && authMode === "api_key") {
        const envName = apiKeyEnvForCommand(command);
        if (!envName) {
          const failed = { ...result, ok: false, message: "This agent does not support API key validation." };
          if (side === "L") setLeftCheck(failed);
          else setRightCheck(failed);
          return;
        }
        const keyCheck = await unwrap(window.tandem.secrets.validateAgentApiKey(envName, apiKey));
        const combined = {
          ...result,
          ok: keyCheck.ok,
          message: keyCheck.ok ? `${result.message} ${keyCheck.message}` : keyCheck.message
        };
        if (side === "L") setLeftCheck(combined);
        else setRightCheck(combined);
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(null);
    }
  }

  async function checkGithub() {
    setChecking("github");
    try {
      const status = await unwrap(window.tandem.board.authStatus());
      if (status.ok) {
        setGithubCheck(status);
        await loadGithubProjectOwners();
        await loadGithubProjects();
      } else {
        const login = await unwrap(window.tandem.board.connect());
        setGithubCheck(login);
        if (login.ok) {
          await loadGithubProjectOwners();
          await loadGithubProjects();
        }
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(null);
    }
  }

  function jiraDraftCreds() {
    return { siteUrl: jiraSiteUrl, email: jiraEmail, apiToken: jiraApiToken.trim() };
  }

  async function checkJira() {
    setChecking("jira");
    setSetupError(null);
    try {
      const token = jiraApiToken.trim();
      if (!token) {
        setJiraCheck({ ok: false, message: "Paste a Jira API token before authenticating." });
        return;
      }
      const status = await unwrap(window.tandem.board.validateJira(jiraDraftCreds()));
      setJiraCheck(status);
      if (status.ok) await loadJiraProjects();
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(null);
    }
  }

  async function loadJiraProjects() {
    setJiraProjectsLoading(true);
    try {
      const projects = await unwrap(window.tandem.jira.listProjects(jiraDraftCreds()));
      setJiraProjects(projects);
      if (!jiraProjectKey.trim() && projects[0]) setJiraProjectKey(projects[0].key);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setJiraProjectsLoading(false);
    }
  }

  async function createJiraProject(key: string, name: string) {
    const dupe = jiraProjects.find(
      (p) => p.key.trim().toUpperCase() === key.trim().toUpperCase() || p.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    if (dupe) {
      setSetupError(
        `A Jira project already exists with that ${dupe.key.trim().toUpperCase() === key.trim().toUpperCase() ? `key "${key}"` : `name "${name}"`} (${dupe.key}). Select it from the list above, or use a different key/name.`
      );
      return;
    }
    setJiraCreating(true);
    setSetupError(null);
    try {
      const project = await unwrap(window.tandem.jira.createProject(jiraDraftCreds(), { key, name }));
      setJiraProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
      setJiraProjectKey(project.key);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setJiraCreating(false);
    }
  }

  async function loadJiraStatuses() {
    const projectKey = jiraProjectKey.trim();
    if (!projectKey) {
      setJiraStatusesError("Pick a Jira project first.");
      return;
    }
    setJiraStatusesLoading(true);
    setJiraStatusesError(null);
    try {
      const result = await unwrap(
        window.tandem.jira.listProjectStatuses(jiraDraftCreds(), projectKey, jiraIssueType.trim() || undefined)
      );
      setJiraStatuses(result.statuses);
      setJiraStatusesUnioned(result.unioned);
      // Auto-map from real statuses: re-map default-equal write slots, propose a read slot per status.
      setStatusMapping((current) => {
        const write = autoMapWrite(result.statuses, current.write);
        const read = autoMapRead(result.statuses, write, current.read, current.ignored);
        return { write, read, ignored: current.ignored };
      });
    } catch (error) {
      setJiraStatuses([]);
      setJiraStatusesError(error instanceof Error ? error.message : String(error));
    } finally {
      setJiraStatusesLoading(false);
    }
  }

  function updateJiraSiteInput(value: string) {
    const parsed = parseJiraBoardUrl(value);
    setJiraSiteUrl(parsed.siteUrl);
    if (parsed.projectKey) setJiraProjectKey(parsed.projectKey);
    if (parsed.boardId) setJiraBoardId(parsed.boardId);
  }

  async function loadGithubProjects() {
    setGithubProjectsLoading(true);
    try {
      const projects = await unwrap(window.tandem.board.listProjects());
      setGithubProjects(projects);
      if (!githubOwner.trim() && !Number(projectNumber) && projects[0]) {
        setGithubOwner(projects[0].owner);
        setProjectNumber(String(projects[0].number));
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setGithubProjectsLoading(false);
    }
  }

  async function loadGithubProjectOwners() {
    try {
      const owners = await unwrap(window.tandem.board.listProjectOwners());
      setGithubProjectOwners(owners);
      if (!githubOwner.trim() && owners[0]) setGithubOwner(owners[0].login);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    }
  }

  async function createGithubProject() {
    setGithubProjectCreating(true);
    setSetupError(null);
    try {
      const title = newBoardTitle.trim() || workspaceName.trim() || "Twindem delivery";
      const project = await unwrap(window.tandem.board.createProject(githubOwner.trim() || "@me", title));
      setGithubOwner(project.owner);
      setProjectNumber(String(project.number));
      setGithubProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
      setBoardSetupMode("existing");
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setGithubProjectCreating(false);
    }
  }

  function updateSetupRoles(side: AgentSide, requestedRoles: string[]) {
    const partition = partitionRolesForSide(side, requestedRoles, leftRoles, rightRoles, Object.keys(config.roles));
    setLeftRoles(partition.L);
    setRightRoles(partition.R);
  }

  async function validateCurrentStep(): Promise<boolean> {
    setSetupError(null);
    if (currentStep === "project") {
      const name = workspaceName.trim();
      if (!name) {
        setSetupError("Project name is required.");
        return false;
      }
      const duplicate = config.workspaces.some((candidate) => candidate.name === name && (newProject || candidate.name !== workspace?.name));
      if (duplicate) {
        setSetupError(`A project named "${name}" already exists.`);
        return false;
      }
      if (!workspaceRoot.trim()) {
        setSetupError("Choose the project/application folder first.");
        return false;
      }
      const folderCheck = await unwrap(window.tandem.config.validateDirectory(workspaceRoot));
      if (!folderCheck.ok) {
        setSetupError(folderCheck.message);
        return false;
      }
    }
    if (currentStep === "board" && boardType === "none") {
      setSetupError("Choose Jira or GitHub. Twindem needs a board as the source of truth.");
      return false;
    }
    if (currentStep === "statuses" && boardType === "jira" && jiraStatuses.length > 0) {
      // Only gate when statuses actually loaded — a load failure shouldn't trap the user.
      const missingSlot = Array.from(MAIN_TRACK_STATUS_SLOTS).find((slot) => !statusMapping.write[slot]?.trim());
      if (missingSlot) {
        setSetupError(`Map a Jira status for the "${boardStatusPhaseLabel(missingSlot)}" step before continuing.`);
        return false;
      }
      const unaccounted = unaccountedStatuses(jiraStatuses, statusMapping.read, statusMapping.ignored);
      if (unaccounted.length > 0) {
        setSetupError(`Map or ignore every board status. Still unaccounted: ${unaccounted.join(", ")}.`);
        return false;
      }
    }
    return true;
  }

  async function goToNextStep() {
    if (!(await validateCurrentStep())) return;
    setStepIndex((index) => Math.min(steps.length - 1, index + 1));
  }

  async function submit() {
    setSetupError(null);
    let selectedGithubOwner = githubOwner;
    let selectedProjectNumber = projectNumber;
    if (!workspaceName.trim()) {
      setSetupError("Project name is required.");
      setStepIndex(0);
      return;
    }
    if (!workspaceRoot.trim()) {
      setSetupError("Choose the project/application folder first.");
      setStepIndex(0);
      return;
    }
    const folderCheck = await unwrap(window.tandem.config.validateDirectory(workspaceRoot));
    if (!folderCheck.ok) {
      setSetupError(folderCheck.message);
      setStepIndex(0);
      return;
    }

    const left = leftCheck?.command === leftCommand.trim() ? leftCheck : await unwrap(window.tandem.system.checkCommand(leftCommand));
    const right =
      rightCheck?.command === rightCommand.trim() ? rightCheck : await unwrap(window.tandem.system.checkCommand(rightCommand));
    setLeftCheck(left);
    setRightCheck(right);
    if (!left.ok || !right.ok) {
      setSetupError("Both agent commands must be available before setup can continue.");
      return;
    }
    if (leftAuthMode === "api_key" && !leftApiKey.trim()) {
      setSetupError("Agent 1 is set to API key auth. Paste the API key before continuing.");
      setStepIndex(2);
      return;
    }
    if (rightAuthMode === "api_key" && !rightApiKey.trim()) {
      setSetupError("Agent 2 is set to API key auth. Paste the API key before continuing.");
      setStepIndex(3);
      return;
    }
    if (leftAuthMode === "api_key") {
      const keyCheck = await unwrap(window.tandem.secrets.validateAgentApiKey(apiKeyEnvForCommand(leftCommand) ?? "", leftApiKey));
      if (!keyCheck.ok) {
        setSetupError(keyCheck.message);
        setStepIndex(2);
        return;
      }
    }
    if (rightAuthMode === "api_key") {
      const keyCheck = await unwrap(window.tandem.secrets.validateAgentApiKey(apiKeyEnvForCommand(rightCommand) ?? "", rightApiKey));
      if (!keyCheck.ok) {
        setSetupError(keyCheck.message);
        setStepIndex(3);
        return;
      }
    }

    if (boardType === "github") {
      const gh = githubCheck?.ok ? githubCheck : await unwrap(window.tandem.board.authStatus());
      setGithubCheck(gh);
      if (!gh.ok) {
        setSetupError("GitHub CLI is not authenticated. Run gh auth login, then click Connect GitHub CLI.");
        return;
      }
      if (boardSetupMode === "create" || !Number(projectNumber)) {
        const title = newBoardTitle.trim() || workspaceName.trim() || "Twindem delivery";
        const project = await unwrap(window.tandem.board.createProject(githubOwner.trim() || "@me", title));
        setGithubOwner(project.owner);
        setProjectNumber(String(project.number));
        setGithubProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
        selectedGithubOwner = project.owner;
        selectedProjectNumber = String(project.number);
      }
      if (!selectedGithubOwner.trim() || !Number(selectedProjectNumber)) {
        setSetupError("Choose or create a GitHub Project before setup can continue.");
        return;
      }
    }
    if (boardType === "jira") {
      if (!jiraSiteUrl.trim() || !jiraProjectKey.trim() || !jiraEmail.trim()) {
        setSetupError("Jira board requires site URL, project key, and email.");
        setStepIndex(4);
        return;
      }
      const jiraSecretRef = workspace?.jiraApiTokenSecretRef ?? jiraApiTokenSecretRef(workspaceName);
      const hasSavedToken = await unwrap(window.tandem.secrets.has(jiraSecretRef)).catch(() => false);
      if (!jiraApiToken.trim() && !hasSavedToken) {
        setSetupError("Jira board requires an API token. Paste it once; Twindem stores it encrypted.");
        setStepIndex(4);
        return;
      }
      if (jiraApiToken.trim()) {
        const status = await unwrap(
          window.tandem.board.validateJira({
            siteUrl: jiraSiteUrl,
            email: jiraEmail,
            apiToken: jiraApiToken
          })
        );
        setJiraCheck(status);
        if (!status.ok) {
          setSetupError(status.message);
          setStepIndex(4);
          return;
        }
      }
    }
    if (boardType === "none") {
      setSetupError("Choose Jira or GitHub. Twindem needs a board as the source of truth.");
      setStepIndex(4);
      return;
    }

    const leftSecretRef = agentApiKeySecretRef(workspaceName, "L");
    const rightSecretRef = agentApiKeySecretRef(workspaceName, "R");
    const jiraSecretRef = jiraApiTokenSecretRef(workspaceName);
    if (leftAuthMode === "api_key") await unwrap(window.tandem.secrets.setAgentApiKey(leftSecretRef, leftApiKey));
    if (rightAuthMode === "api_key") await unwrap(window.tandem.secrets.setAgentApiKey(rightSecretRef, rightApiKey));
    if (boardType === "jira" && jiraApiToken.trim()) await unwrap(window.tandem.secrets.set(jiraSecretRef, jiraApiToken));

    await onSave(
      buildOnboardingConfig(config, {
        workspaceName,
        workspaceRoot,
        description,
        agentInstructions,
        uatReleaseInstructions,
        prodReleaseInstructions,
        mode,
        boardType,
        githubOwner: selectedGithubOwner,
        projectNumber: selectedProjectNumber,
        issueRepository,
        jiraSiteUrl,
        jiraProjectKey,
        jiraBoardId,
        jiraIssueType,
        jiraEmail,
        jiraApiTokenSecretRef: boardType === "jira" ? jiraSecretRef : undefined,
        allowedRepoPaths: allowedRepoPaths
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean),
        projectLayout: projectLayout
          .map((entry) => ({ label: entry.label.trim(), path: entry.path.trim(), repo: entry.repo }))
          .filter((entry) => entry.label && entry.path),
        principalRepo: principalRepo ? { owner: principalRepo.owner, name: principalRepo.name, path: "" } : undefined,
        leftCommand,
        leftArgs,
        leftModel,
        leftAuthMode,
        leftDangerouslySkipPermissions,
        leftSecretRef,
        leftRoles,
        rightCommand,
        rightArgs,
        rightModel,
        rightAuthMode,
        rightDangerouslySkipPermissions,
        rightSecretRef,
        rightRoles,
        automationLevel: onboardingAutomation,
        // The user-curated grid is the source of truth; slotForBoardStatus merges defaults at runtime.
        statusMapping:
          boardType === "jira" && jiraStatuses.length > 0
            ? { write: statusMapping.write, read: statusMapping.read, ignored: statusMapping.ignored }
            : undefined
      })
    );
  }

  return (
    <div className="modal-backdrop onboarding-backdrop">
      <section className="onboarding-dialog">
        <header>
          <div>
            <span className="eyebrow">{newProject ? "New project" : "First run setup"}</span>
            <h2>{newProject ? "Create a project" : "Set up Twindem"}</h2>
            <p>Choose the project, local folder, two agent CLIs, and the board Twindem should coordinate through.</p>
          </div>
          {onCancel && <button onClick={onCancel}>Close</button>}
        </header>

        {setupError && (
          <div className="settings-error">
            <span>{setupError}</span>
            <button onClick={() => setSetupError(null)}>Dismiss</button>
          </div>
        )}

        <nav className="onboarding-steps" aria-label="Project setup steps">
          {steps.map((step, index) => (
            <button
              key={step.key}
              className={index === stepIndex ? "active" : index < stepIndex ? "complete" : ""}
              onClick={() => {
                if (index <= stepIndex) setStepIndex(index);
                else void validateCurrentStep().then((ok) => {
                  if (ok) setStepIndex(index);
                });
              }}
            >
              <span>{index + 1}</span>
              {step.label}
            </button>
          ))}
        </nav>

        {currentStep === "project" && (
        <section className="setup-section">
          <div>
            <span className="setup-step">1</span>
            <h3>Project</h3>
          </div>
          <div className="settings-grid">
            <label>
              Name
              <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
            </label>
            <label>
              Local folder
              <span className="inline-field">
                <input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} />
                <button onClick={() => void browseWorkspaceRoot()}>Browse</button>
              </span>
            </label>
            <label className="full">
              Principal repo <span className="field-optional">(root code — optional)</span>
              <RepoField
                value={principalRepo}
                adoptPath={workspaceRoot.trim() || undefined}
                onChange={setPrincipalRepo}
                onNotice={(m) => setSetupError(m)}
              />
              <small className="field-hint">
                Root code repo + catch-all (separate from the board's issue repo). Adopt the folder's repo, browse, or create.
              </small>
            </label>
            <label className="full">
              Project layout <span className="field-optional">(components — optional)</span>
              <ProjectLayoutEditor value={projectLayout} onChange={setProjectLayout} root={workspaceRoot} onNotice={(m) => setSetupError(m)} />
              <small className="field-hint">
                Tell the agents how the folder is structured. Paths are <strong>relative to the project folder</strong> —
                e.g. <code>backend</code>, <code>apps/web</code> (so backend lives at &lt;project folder&gt;/backend).
                Injected into their brief so they create/edit code in the right place; these paths also count as
                allowed implementation scope.
              </small>
            </label>
          </div>
        </section>
        )}

        {currentStep === "context" && (
        <section className="setup-section">
          <div>
            <span className="setup-step">2</span>
            <h3>Project context</h3>
          </div>
          <div className="settings-grid setup-context-grid">
            <label>
              Description
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this project is, who it serves, and what matters."
              />
            </label>
            <label>
              Agent instructions
              <textarea
                value={agentInstructions}
                onChange={(event) => setAgentInstructions(event.target.value)}
                placeholder="Standing conventions the agents should follow for this project."
              />
            </label>
            <label>
              Release in UAT
              <textarea
                value={uatReleaseInstructions}
                onChange={(event) => setUatReleaseInstructions(event.target.value)}
                placeholder="Optional UAT release runbook."
              />
            </label>
            <label>
              Release in Prod
              <textarea
                value={prodReleaseInstructions}
                onChange={(event) => setProdReleaseInstructions(event.target.value)}
                placeholder="Optional production release runbook."
              />
            </label>
          </div>
        </section>
        )}

        {currentStep === "agent1" && (
        <section className="setup-section">
          <div>
            <span className="setup-step">3</span>
            <h3>Agent 1</h3>
          </div>
          <AgentSetupFields
            command={leftCommand}
            args={leftArgs}
            model={leftModel}
            check={leftCheck}
            checking={checking === "L"}
            onCommandChange={(value) => {
              setLeftCommand(value);
              setLeftAuthMode(defaultAuthModeForCommand(value));
              setLeftCheck(null);
            }}
            onArgsChange={setLeftArgs}
            onModelChange={setLeftModel}
            authMode={leftAuthMode}
            dangerouslySkipPermissions={leftDangerouslySkipPermissions}
            apiKey={leftApiKey}
            onAuthModeChange={setLeftAuthMode}
            onDangerouslySkipPermissionsChange={setLeftDangerouslySkipPermissions}
            onApiKeyChange={setLeftApiKey}
            roles={leftRoles}
            allRoles={Object.keys(config.roles)}
            onRolesChange={(roles) => updateSetupRoles("L", roles)}
            onCheck={() => void checkCommand("L")}
          />
        </section>
        )}

        {currentStep === "agent2" && (
        <section className="setup-section">
          <div>
            <span className="setup-step">4</span>
            <h3>Agent 2</h3>
          </div>
          <AgentSetupFields
            command={rightCommand}
            args={rightArgs}
            model={rightModel}
            check={rightCheck}
            checking={checking === "R"}
            onCommandChange={(value) => {
              setRightCommand(value);
              setRightAuthMode(defaultAuthModeForCommand(value));
              setRightCheck(null);
            }}
            onArgsChange={setRightArgs}
            onModelChange={setRightModel}
            authMode={rightAuthMode}
            dangerouslySkipPermissions={rightDangerouslySkipPermissions}
            apiKey={rightApiKey}
            onAuthModeChange={setRightAuthMode}
            onDangerouslySkipPermissionsChange={setRightDangerouslySkipPermissions}
            onApiKeyChange={setRightApiKey}
            roles={rightRoles}
            allRoles={Object.keys(config.roles)}
            onRolesChange={(roles) => updateSetupRoles("R", roles)}
            onCheck={() => void checkCommand("R")}
          />
          <div className="setup-automation">
            <h4>Review mode</h4>
            <p className="field-optional">
              How the two agents hand off inside a step. You always move between steps yourself — neither
              mode advances the board status automatically.
            </p>
            <div className="automation-settings-grid">
              {(["manual", "auto"] as const).map((level) => (
                <button
                  type="button"
                  key={level}
                  className={onboardingAutomation === level ? "automation-choice selected" : "automation-choice"}
                  onClick={() => setOnboardingAutomation(level)}
                >
                  <strong>{automationLabel(level)}</strong>
                  <span>{automationDescription(level)}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
        )}

        {currentStep === "board" && (
        <section className="setup-section">
          <div>
            <span className="setup-step">5</span>
            <h3>Board</h3>
          </div>
          <BoardSetupFields
            value={{
              boardType,
              boardSetupMode,
              githubOwner,
              projectNumber,
              issueRepository,
              newBoardTitle,
              jiraSiteUrl,
              jiraEmail,
              jiraApiToken,
              jiraProjectKey,
              jiraIssueType
            }}
            onChange={(patch) => {
              if (patch.boardType !== undefined) setBoardType(patch.boardType);
              if (patch.boardSetupMode !== undefined) setBoardSetupMode(patch.boardSetupMode);
              if (patch.githubOwner !== undefined) setGithubOwner(patch.githubOwner);
              if (patch.projectNumber !== undefined) setProjectNumber(patch.projectNumber);
              if (patch.issueRepository !== undefined) setIssueRepository(patch.issueRepository);
              if (patch.newBoardTitle !== undefined) setNewBoardTitle(patch.newBoardTitle);
              if (patch.jiraSiteUrl !== undefined) updateJiraSiteInput(patch.jiraSiteUrl);
              if (patch.jiraEmail !== undefined) setJiraEmail(patch.jiraEmail);
              if (patch.jiraApiToken !== undefined) setJiraApiToken(patch.jiraApiToken);
              if (patch.jiraProjectKey !== undefined) setJiraProjectKey(patch.jiraProjectKey);
              if (patch.jiraIssueType !== undefined) setJiraIssueType(patch.jiraIssueType);
            }}
            github={{
              projects: githubProjects,
              owners: githubProjectOwners,
              loading: githubProjectsLoading,
              creating: githubProjectCreating,
              checking: checking === "github",
              check: githubCheck,
              onConnect: () => void checkGithub(),
              onRefresh: () => void loadGithubProjects(),
              onCreateProject: () => void createGithubProject()
            }}
            jira={{
              projects: jiraProjects,
              loading: jiraProjectsLoading,
              creating: jiraCreating,
              authChecking: checking === "jira",
              authed: Boolean(jiraCheck?.ok),
              check: jiraCheck,
              tokenSavedHint: Boolean(workspace?.jiraApiTokenSecretRef),
              onAuthenticate: () => void checkJira(),
              onRefreshProjects: () => void loadJiraProjects(),
              onCreateProject: (key, name) => void createJiraProject(key, name)
            }}
            helpTopic={boardHelpTopic}
            onHelpTopicChange={setBoardHelpTopic}
            workspaceName={workspaceName}
          />
        </section>
        )}

        {currentStep === "code" && (
        <section className="setup-section">
          <div>
            <span className="setup-step">6</span>
            <h3>Code / Repo</h3>
          </div>
          <div className="settings-grid">
            <label className="full">
              Allowed implementation repos / paths <span className="field-optional">(optional)</span>
              <textarea
                rows={4}
                value={allowedRepoPaths}
                onChange={(event) => setAllowedRepoPaths(event.target.value)}
                placeholder={"Most projects: leave empty.\nAdd a path only if code lives outside the project folder, e.g.\n/Users/you/dev/other-repo"}
              />
              <small className="field-hint">
                Leave empty and agents work inside your project folder only. Add paths (one per line) only
                if this project's code spans extra local folders/repos — e.g. a separate backend repo.
              </small>
            </label>
          </div>
        </section>
        )}

        {currentStep === "statuses" && (
        <section className="setup-section">
          <div>
            <span className="setup-step">7</span>
            <h3>Status mapping</h3>
          </div>
          {boardType === "jira" ? (
            <>
              <p className="setup-note">
                Map your board's real statuses to Twindem's workflow steps. Auto-mapped by name — adjust any
                row. Every status must map to a step or be marked outside the workflow.
              </p>
              <StatusMappingEditor
                statuses={jiraStatuses}
                value={statusMapping}
                onChange={setStatusMapping}
                loading={jiraStatusesLoading}
                onRefresh={() => void loadJiraStatuses()}
                error={jiraStatusesError}
                unioned={jiraStatusesUnioned}
              />
            </>
          ) : (
            <>
              <div className="status-mapping-preview">
                {Array.from(MAIN_TRACK_STATUS_SLOTS).map((slot) => (
                  <div key={slot}>
                    <span>{boardStatusPhaseLabel(slot)}</span>
                    <strong>{boardStatusForSlot(slot, workspace)}</strong>
                  </div>
                ))}
              </div>
              <p className="setup-note">
                Twindem keeps fixed internal workflow slots and maps each board's real status names onto them.
                GitHub Projects are auto-mapped by status name.
              </p>
            </>
          )}
        </section>
        )}

        <footer>
          <span>Saved locally in your Twindem config and editable later from Settings.</span>
          <div className="footer-actions">
            <button onClick={() => setStepIndex((index) => Math.max(0, index - 1))} disabled={stepIndex === 0}>
              Back
            </button>
            {stepIndex < steps.length - 1 ? (
              <button className="primary" onClick={() => void goToNextStep()}>
                Next
              </button>
            ) : (
              <button className="primary" onClick={() => void submit()}>
                {newProject ? "Create project" : "Save setup"}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

function SessionPreviewDialog({
  detail,
  config,
  onCancel,
  onEdit,
  onStart,
  onStartRefinement,
  onStatusChange
}: {
  detail: SessionDetail;
  config: TandemConfig;
  onCancel: () => void;
  onEdit: () => void;
  onStart: () => void;
  onStartRefinement: () => void;
  onStatusChange: (slot: BoardStatusSlot) => void;
}) {
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  const latestEvidence = detail.evidenceRecords.at(-1);
  const latestEvent = detail.workflowEvents[0];
  const boardRef = boardArtifactRefForSession(detail.session);
  const status = boardStatusForSession(detail) ?? detail.session.visiblePhase;
  const currentSlot = slotForBoardStatus(status, workspace) ?? VISIBLE_PHASE_TO_SLOT[detail.session.visiblePhase] ?? "inbox";
  const statusSlots = MAIN_TRACK_STATUS_SLOTS;
  const [draftStatusSlot, setDraftStatusSlot] = useState<BoardStatusSlot>(currentSlot);
  useEffect(() => {
    setDraftStatusSlot(currentSlot);
  }, [currentSlot, detail.session.id]);
  // A NOT STARTED task (no agent runs yet) starts its work in one click: Start refinement → move to
  // Planning + brief Agent 1. Already-touched sessions start Agent 1 with an immediate catch-up
  // brief so the user doesn't need a compact restart just to make the agent move.
  const notStarted = taskBadge(detail.session, workspace).key === "not_started";
  return (
    <div className="modal-backdrop">
      <section className="session-preview-dialog">
        <header>
          <div>
            <span className="eyebrow">Session preview</span>
            <h2>{detail.board?.title || detail.github?.title || detail.session.title}</h2>
            <p>
              {notStarted
                ? "This task hasn't started yet. Start refinement to move it to Planning and brief Agent 1."
                : "Review the current state before starting Agent 1 with the latest board context."}
            </p>
          </div>
          <button onClick={onCancel}>Close</button>
        </header>
        <div className="session-preview-meta">
          <div>
            <small>Board ref</small>
            <strong>{boardRef}</strong>
          </div>
          <div>
            <small>Last evidence</small>
            <strong>{latestEvidence ? latestEvidence.title : "No evidence yet"}</strong>
          </div>
          <div>
            <small>Last workflow event</small>
            <strong>{latestEvent ? latestEvent.action : "No workflow events yet"}</strong>
          </div>
        </div>
        <section className="session-preview-status-row">
          <div>
            <small>Status</small>
            <strong>{boardStatusForSlot(currentSlot, workspace)}</strong>
          </div>
          <div className="session-preview-status-control">
            <label className="session-preview-status-select">
              <select value={draftStatusSlot} onChange={(event) => setDraftStatusSlot(event.target.value as BoardStatusSlot)}>
                {Array.from(statusSlots).map((slot) => (
                  <option key={slot} value={slot}>
                    {boardStatusForSlot(slot, workspace)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="mini-apply"
              disabled={draftStatusSlot === currentSlot}
              onClick={() => onStatusChange(draftStatusSlot)}
            >
              Apply
            </button>
          </div>
        </section>
        {detail.session.initialBody && !detail.session.boardItemId && !detail.session.repo && (
          <section className="task-context-section">
            <h3>Seed</h3>
            <p>{compactUiText(detail.session.initialBody, 700)}</p>
          </section>
        )}
        <BriefPanel detail={detail} workspace={workspace} />
        <CompactEvidencePanel records={detail.evidenceRecords ?? []} />
        <footer>
          <span>Cancel leaves the current session untouched.</span>
          <div className="footer-actions">
            <button onClick={onCancel}>Cancel</button>
            {notStarted && <button onClick={onEdit}>Edit</button>}
            {notStarted ? (
              <>
                <button onClick={onStart}>Just open</button>
                <button className="primary" onClick={onStartRefinement}>Start refinement</button>
              </>
            ) : (
              <button className="primary" onClick={onStart}>Start Agent 1</button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

// Twindem is Apache-2.0 (matches twindem.ai). Major bundled OSS deps acknowledged here; the full list
// can be auto-generated from node_modules later.
const THIRD_PARTY_DEPS = [
  { name: "Electron", license: "MIT" },
  { name: "React", license: "MIT" },
  { name: "Vite", license: "MIT" },
  { name: "better-sqlite3", license: "MIT" },
  { name: "xterm.js", license: "MIT" },
  { name: "zod", license: "MIT" }
];

function AboutContent({ version }: { version: string }) {
  return (
    <div className="about-content">
      <div className="about-head">
        <img className="about-logo" src={twindemLogo} alt="Twindem" width={48} height={48} />
        <div>
          <h2>Twindem</h2>
          <p className="about-tagline">Provable AI delivery.</p>
          <p className="about-version">Version {version || "—"}</p>
        </div>
      </div>
      <div className="about-section">
        <h3>License</h3>
        <p>
          Twindem is open source under the <strong>Apache License 2.0</strong>. You may use, modify, and
          distribute it under the terms of that license, which includes an explicit patent grant.
        </p>
        <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noreferrer">
          apache.org/licenses/LICENSE-2.0
        </a>
      </div>
      <div className="about-section">
        <h3>Open-source acknowledgements</h3>
        <p className="field-hint">Twindem is built with these and other open-source packages:</p>
        <ul className="about-deps">
          {THIRD_PARTY_DEPS.map((dep) => (
            <li key={dep.name}>
              <span>{dep.name}</span>
              <em>{dep.license}</em>
            </li>
          ))}
        </ul>
      </div>
      <div className="about-section">
        <a href="https://twindem.ai" target="_blank" rel="noreferrer">
          twindem.ai
        </a>
        <p className="about-copyright">© {new Date().getFullYear()} Twindem</p>
      </div>
    </div>
  );
}

function AboutDialog({ version, onClose }: { version: string; onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="about-dialog">
        <header>
          <span className="eyebrow">About</span>
          <button onClick={onClose}>Close</button>
        </header>
        <AboutContent version={version} />
        <footer>
          <button className="primary" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}

function FolderTrustDialog({
  side,
  onCancel,
  onApproved
}: {
  side: AgentSide;
  onCancel: () => void;
  onApproved: () => void;
}) {
  const agent = side === "L" ? "Agent 1" : "Agent 2";
  return (
    <div className="modal-backdrop">
      <section className="folder-trust-dialog">
        <header>
          <div>
            <span className="eyebrow">Folder trust required</span>
            <h2>{agent} is waiting for project folder approval</h2>
            <p>
              Approve the folder trust prompt in the {agent} terminal. Twindem will keep the briefing
              paused and send it only after you confirm here.
            </p>
          </div>
        </header>
        <div className="folder-trust-note">
          This usually appears the first time Codex or Claude opens a new local project folder.
          Do not start a new task or resend manually; approve it in the terminal, then continue here.
        </div>
        <footer>
          <button onClick={onCancel}>Cancel briefing</button>
          <button className="primary" onClick={onApproved}>I approved it in the terminal</button>
        </footer>
      </section>
    </div>
  );
}

// A meaningful status badge only when it adds info — "selected" is already conveyed by the checkbox,
// so it shows nothing (avoids the cryptic bare "selected" label next to every row).
function taskStatusBadge(task: ProposedTask): string | null {
  if (task.status === "created") return task.boardRef ? `Created · ${task.boardRef}` : "Created";
  if (task.status === "failed") return "Failed";
  if (task.status === "skipped") return "Skipped";
  return null;
}

function architectureFindingTasks(findings: ReviewFinding[]): ProposedTask[] {
  return findings
    .filter((finding) => finding.severity === "blocking" && finding.status !== "verified" && finding.status !== "waived")
    .slice(0, 12)
    .map((finding, index) => {
      const findingTitle = compactUiText(finding.title || finding.id, 90);
      return {
        id: `T${index + 1}`,
        status: "selected",
        title: `Resolve architecture finding ${finding.id}: ${findingTitle}`,
        type: "architecture",
        summary: compactUiText(
          [
            `Follow-up from Agent 2 finding ${finding.id}.`,
            finding.detail,
            finding.file ? `Referenced area: ${finding.file}${finding.line ? `:${finding.line}` : ""}.` : ""
          ]
            .filter(Boolean)
            .join(" "),
          2000
        ),
        acceptanceCriteria: [
          `The Architecture work product explicitly resolves ${finding.id}: ${finding.title}.`,
          "The decision, alternatives/tradeoffs, risks, validation evidence, and open questions are documented clearly enough for Agent 2 to re-review."
        ].join(" "),
        targetRepo: finding.file,
        fingerprint: `architecture-finding::${finding.id}::${findingTitle.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`
      } satisfies ProposedTask;
    });
}

function TaskProposalDialog({
  modal,
  onChange,
  onCancel,
  onCreate
}: {
  modal: TaskProposalModalState;
  onChange: (tasks: ProposedTask[]) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const editableTasks = modal.tasks.filter((task) => task.status !== "created");
  const selectableCount = editableTasks.filter((task) => task.status !== "skipped").length;
  const updateTask = (id: string, patch: Partial<ProposedTask>) => {
    onChange(
      modal.tasks.map((task) =>
        task.id === id
          ? {
              ...task,
              ...patch,
              fingerprint: patch.title || patch.type ? undefined : task.fingerprint
            }
          : task
      )
    );
  };
  const toggleTask = (task: ProposedTask, checked: boolean) => {
    if (task.status === "created") return;
    updateTask(task.id, { status: checked ? "selected" : "skipped" });
  };
  return (
    <div className="modal-backdrop">
      <section className="task-proposal-dialog">
        <header>
          <div>
            <span className="eyebrow">Architecture follow-up</span>
            <h2>Proposed follow-up tasks</h2>
            <p>
              Review the tasks derived from the ADR or unresolved review findings. Confirmed rows become board items;
              they do not open agent sessions automatically.
            </p>
          </div>
          <button onClick={onCancel} disabled={modal.creating}>Close</button>
        </header>
        <div className="task-proposal-source">
          <small>Source ADR</small>
          <strong>{modal.sourceBoardRef}</strong>
        </div>
        <div className="task-proposal-list">
          {modal.tasks.map((task) => {
            const locked = modal.creating || task.status === "created";
            const checked = task.status !== "skipped" && task.status !== "created";
            return (
              <article key={task.id} className={`task-proposal-row status-${task.status}`}>
                <label className="task-proposal-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={locked}
                    onChange={(event) => toggleTask(task, event.target.checked)}
                  />
                  <span>{task.id}</span>
                </label>
                <div className="task-proposal-fields">
                  <div className="task-proposal-line">
                    <input
                      value={task.title}
                      disabled={locked || !checked}
                      onChange={(event) => updateTask(task.id, { title: event.target.value })}
                      placeholder="Task title"
                    />
                    <select
                      value={task.type}
                      disabled={locked || !checked}
                      onChange={(event) => updateTask(task.id, { type: event.target.value as ProposedTask["type"] })}
                    >
                      <option value="feature">Feature</option>
                      <option value="bug">Bug</option>
                      <option value="spike">Spike</option>
                      <option value="architecture">Architecture</option>
                      <option value="research">Research</option>
                      <option value="runbook">Runbook</option>
                    </select>
                  </div>
                  <textarea
                    rows={3}
                    value={task.summary}
                    disabled={locked || !checked}
                    onChange={(event) => updateTask(task.id, { summary: event.target.value })}
                    placeholder="Scope and rationale"
                  />
                  <textarea
                    rows={2}
                    value={task.acceptanceCriteria ?? ""}
                    disabled={locked || !checked}
                    onChange={(event) => updateTask(task.id, { acceptanceCriteria: event.target.value || undefined })}
                    placeholder="Acceptance criteria"
                  />
                  <div className="task-proposal-line secondary">
                    <label className="task-proposal-target">
                      <span>Target</span>
                      <input
                        value={task.targetRepo && task.targetRepo !== "." ? task.targetRepo : ""}
                        disabled={locked || !checked}
                        onChange={(event) => updateTask(task.id, { targetRepo: event.target.value || undefined })}
                        placeholder="Current workspace"
                      />
                    </label>
                    {taskStatusBadge(task) && (
                      <span className={`task-proposal-status badge-${task.status}`}>{taskStatusBadge(task)}</span>
                    )}
                  </div>
                  {task.error && <p className="task-proposal-error">{task.error}</p>}
                </div>
              </article>
            );
          })}
        </div>
        <footer>
          <span>
            {selectableCount} selected · created tasks stay linked to the source ADR as evidence.
          </span>
          <div className="footer-actions">
            <button onClick={onCancel} disabled={modal.creating}>Cancel</button>
            <button className="primary" onClick={onCreate} disabled={modal.creating || selectableCount === 0}>
              {modal.creating ? "Creating..." : "Create selected tasks"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function AgentSetupFields({
  command,
  args,
  check,
  checking,
  onCommandChange,
  onArgsChange,
  onModelChange,
  authMode,
  dangerouslySkipPermissions,
  apiKey,
  onAuthModeChange,
  onDangerouslySkipPermissionsChange,
  onApiKeyChange,
  roles,
  allRoles,
  onRolesChange,
  onCheck
}: {
  command: string;
  args: string;
  model: string;
  check: CommandCheckResult | null;
  checking: boolean;
  onCommandChange: (value: string) => void;
  onArgsChange: (value: string) => void;
  onModelChange: (value: string) => void;
  authMode: AgentAuthMode;
  dangerouslySkipPermissions: boolean;
  apiKey: string;
  onAuthModeChange: (value: AgentAuthMode) => void;
  onDangerouslySkipPermissionsChange: (value: boolean) => void;
  onApiKeyChange: (value: string) => void;
  roles: string[];
  allRoles: string[];
  onRolesChange: (roles: string[]) => void;
  onCheck: () => void;
}) {
  const agent = catalogAgentFor(command);
  const selectedModel = catalogModelFor(agent, args);
  const family = providerFamily({ label: agent.label, command });
  const supportsAuth = family === "codex" || family === "claude";
  const installCommand = installCommandForAgent(command);

  function pickAgent(nextCommand: string) {
    const nextAgent = catalogAgentFor(nextCommand);
    const firstModel = nextAgent.models[0];
    const nextFamily = providerFamily({ label: nextAgent.label, command: nextAgent.command });
    onCommandChange(nextAgent.command);
    onArgsChange(firstModel.args.join(" "));
    onModelChange(firstModel.label);
    onAuthModeChange(defaultAuthModeForCommand(nextAgent.command));
    if (nextFamily !== "codex" && nextFamily !== "claude") onDangerouslySkipPermissionsChange(false);
  }

  function pickModel(modelId: string) {
    const model = agent.models.find((candidate) => candidate.id === modelId) ?? agent.models[0];
    onArgsChange(model.args.join(" "));
    onModelChange(model.label);
  }

  return (
    <div className="settings-grid setup-agent-grid">
      <label>
        Agent CLI
        <select value={agent.command} onChange={(event) => pickAgent(event.target.value)}>
          {AGENT_CATALOG.map((candidate) => (
            <option key={candidate.command} value={candidate.command}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model
        <select value={selectedModel.id} onChange={(event) => pickModel(event.target.value)}>
          {agent.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <RoleChecklist title="Responsibilities" roles={roles} allRoles={allRoles} allowEmpty onChange={onRolesChange} />
      {supportsAuth && (
        <>
          <label>
            Auth
            <select value={authMode} onChange={(event) => onAuthModeChange(event.target.value as AgentAuthMode)}>
              <option value="subscription">Subscription login</option>
              <option value="api_key">API key</option>
            </select>
          </label>
          {authMode === "api_key" && (
            <label>
              API key
              <input
                type="password"
                value={apiKey}
                onChange={(event) => onApiKeyChange(event.target.value)}
                placeholder={family === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}
              />
            </label>
          )}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={dangerouslySkipPermissions}
              onChange={(event) => onDangerouslySkipPermissionsChange(event.target.checked)}
            />
            Skip CLI permission prompts (dangerous)
          </label>
        </>
      )}
      <div className="setup-check-row">
        <button onClick={onCheck} disabled={checking || !command.trim()}>
          {checking ? "Checking..." : authMode === "api_key" ? "Check agent" : "Check CLI"}
        </button>
        {check && <span className={check.ok ? "check-ok" : "check-bad"}>{check.message}</span>}
      </div>
      {check && !check.ok && installCommand && (
        <div className="install-hint">
          <span>Install locally, then click Check CLI again:</span>
          <code>{installCommand}</code>
        </div>
      )}
    </div>
  );
}

type ProjectDeleteTarget = {
  name: string;
  root: string;
  sessionCount: number;
  deleteSourceFolder: boolean;
  confirmationName: string;
  deleting: boolean;
  error?: string;
};

function ProjectsDialog({
  config,
  sessions,
  activeWorkspaceName,
  onClose,
  onSetActive,
  onDeleted
}: {
  config: TandemConfig;
  sessions: SessionSummary[];
  activeWorkspaceName?: string;
  onClose: () => void;
  onSetActive: (name: string) => void;
  onDeleted: (deletedName: string, deletedSessions: number, sourceFolderDeleted?: boolean, sourceFolderDeleteError?: string) => void | Promise<void>;
}) {
  const [deleteTarget, setDeleteTarget] = useState<ProjectDeleteTarget | null>(null);
  const workspaceNames = useMemo(() => config.workspaces.map((workspace) => workspace.name), [config.workspaces]);
  const [usageByWorkspace, setUsageByWorkspace] = useState<Record<string, UsageSummary | null>>({});
  const sessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      const name = session.workspaceName ?? config.defaults.workspaceName ?? "";
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [config.defaults.workspaceName, sessions]);
  useEffect(() => {
    let cancelled = false;
    const loadUsage = async () => {
      const entries = await Promise.all(
        workspaceNames.map(async (name) => {
          const result = await window.tandem.usage.workspaceSummary(name).catch(() => null);
          return [name, result?.ok ? result.data ?? null : null] as const;
        })
      );
      if (!cancelled) setUsageByWorkspace(Object.fromEntries(entries));
    };
    void loadUsage();
    return () => {
      cancelled = true;
    };
  }, [workspaceNames]);

  async function deleteProject() {
    if (!deleteTarget) return;
    setDeleteTarget({ ...deleteTarget, deleting: true, error: undefined });
    const result = await window.tandem.config.deleteProject(deleteTarget.name, {
      deleteSourceFolder: deleteTarget.deleteSourceFolder,
      confirmationName: deleteTarget.deleteSourceFolder ? deleteTarget.confirmationName : undefined
    });
    if (!result.ok) {
      setDeleteTarget({ ...deleteTarget, deleting: false, error: result.error.message });
      return;
    }
    setDeleteTarget(null);
    await onDeleted(result.data.project, result.data.deletedSessions, result.data.sourceFolderDeleted, result.data.sourceFolderDeleteError);
  }

  return (
    <div className="modal-backdrop">
      {deleteTarget && (
        <div className="modal-backdrop nested">
          <section className="confirm-dialog danger-dialog project-delete-confirm">
            <h2>Delete “{deleteTarget.name}”?</h2>
            <p>
              This removes all Twindem local data for this project: sessions, transcripts, evidence, agent runs,
              local cache, saved project tokens, and the project config entry. Remote Jira/GitHub board items are not deleted.
            </p>
            <p className="confirm-note">Source folder: {deleteTarget.root || "not configured"}</p>
            <label className="delete-board-option">
              <input
                type="checkbox"
                checked={deleteTarget.deleteSourceFolder}
                onChange={(event) =>
                  setDeleteTarget((current) => current ? { ...current, deleteSourceFolder: event.target.checked, confirmationName: "" } : current)
                }
              />
              <span>Delete source folder also</span>
            </label>
            {deleteTarget.deleteSourceFolder && (
              <label>
                Type the project name to confirm source deletion
                <input
                  value={deleteTarget.confirmationName}
                  onChange={(event) => setDeleteTarget((current) => current ? { ...current, confirmationName: event.target.value } : current)}
                  placeholder={deleteTarget.name}
                />
              </label>
            )}
            {deleteTarget.error && <p className="task-proposal-error">{deleteTarget.error}</p>}
            <div className="footer-actions">
              <button onClick={() => setDeleteTarget(null)} disabled={deleteTarget.deleting}>Cancel</button>
              <button
                className="danger"
                onClick={() => void deleteProject()}
                disabled={deleteTarget.deleting || (deleteTarget.deleteSourceFolder && deleteTarget.confirmationName !== deleteTarget.name)}
              >
                {deleteTarget.deleting ? "Deleting..." : "Delete project"}
              </button>
            </div>
          </section>
        </div>
      )}
      <section className="settings-dialog refined projects-dialog">
        <header>
          <div>
            <span className="eyebrow">Projects</span>
            <h2>Projects</h2>
            <p>Manage Twindem projects and local project data. Remote board items are never deleted here.</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>
        <div className="projects-list">
          {config.workspaces.map((workspace) => {
            const provider = boardProviderForWorkspace(config, workspace);
            const boardLabel =
              provider === "jira"
                ? `Jira · ${workspace.jiraProjectKey ?? "not configured"}`
                : provider === "github_project"
                  ? workspace.githubOwner && workspace.projectNumber
                    ? `GitHub · ${workspace.githubOwner} #${workspace.projectNumber}`
                    : "GitHub · not configured"
                  : "No board";
            const isActive = workspace.name === activeWorkspaceName;
            const sessionCount = sessionCounts.get(workspace.name) ?? 0;
            const usage = usageByWorkspace[workspace.name];
            return (
              <article key={workspace.name} className="project-row-card">
                <div>
                  <div className="project-row-title">
                    <strong>{workspace.name}</strong>
                    {isActive && <span>Active</span>}
                  </div>
                  <p>{boardLabel}</p>
                  <div className="project-row-usage">
                    {usage === undefined
                      ? "Usage loading..."
                      : usage
                        ? `~${formatCompactVolume(usage.totalEstimateTokens)} estimated terminal volume · in/out ~${formatCompactVolume(usage.inputEstimateTokens)} / ~${formatCompactVolume(usage.outputEstimateTokens)}`
                        : "No usage recorded yet"}
                  </div>
                  <small>{workspace.root || "No local folder"}</small>
                </div>
                <div className="project-row-meta">
                  <span>{sessionCount} task{sessionCount === 1 ? "" : "s"}</span>
                  <button onClick={() => onSetActive(workspace.name)} disabled={isActive}>Set active</button>
                  <button
                    className="danger"
                    onClick={() =>
                      setDeleteTarget({
                        name: workspace.name,
                        root: workspace.root,
                        sessionCount,
                        deleteSourceFolder: false,
                        confirmationName: "",
                        deleting: false
                      })
                    }
                    disabled={config.workspaces.length <= 1}
                    title={config.workspaces.length <= 1 ? "Create another project before deleting the only project." : "Delete Twindem local data for this project."}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SettingsDialog({
  config,
  githubAuthStatus,
  githubAuthChecking,
  onCheckGithub,
  onCancel,
  onSave,
  onProjectDeleted
}: {
  config: TandemConfig;
  githubAuthStatus: GitHubAuthStatus | null;
  githubAuthChecking: boolean;
  onCheckGithub: () => Promise<void>;
  onCancel: () => void;
  onSave: (config: TandemConfig) => Promise<void>;
  onProjectDeleted: (deletedName: string, deletedSessions: number) => void | Promise<void>;
}) {
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TandemConfig>(() => normalizeConfigRolePartition(structuredClone(config)));
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [githubProjects, setGithubProjects] = useState<GitHubProjectOption[]>([]);
  const [githubProjectOwners, setGithubProjectOwners] = useState<GitHubProjectOwnerOption[]>([]);
  const [githubProjectsLoading, setGithubProjectsLoading] = useState(false);
  const [profileApiKeys, setProfileApiKeys] = useState<Record<string, string>>({});
  const [settingsJiraApiToken, setSettingsJiraApiToken] = useState("");
  const [settingsJiraCheck, setSettingsJiraCheck] = useState<GitHubAuthStatus | null>(null);
  const [settingsBoardHelpTopic, setSettingsBoardHelpTopic] = useState<BoardHelpTopic>(null);
  const [settingsJiraProjects, setSettingsJiraProjects] = useState<JiraProjectOption[]>([]);
  const [settingsJiraProjectsLoading, setSettingsJiraProjectsLoading] = useState(false);
  const [settingsJiraCreating, setSettingsJiraCreating] = useState(false);
  const [settingsJiraStatuses, setSettingsJiraStatuses] = useState<string[]>([]);
  const [settingsJiraStatusesLoading, setSettingsJiraStatusesLoading] = useState(false);
  const [settingsJiraStatusesError, setSettingsJiraStatusesError] = useState<string | null>(null);
  const [settingsJiraStatusesUnioned, setSettingsJiraStatusesUnioned] = useState(false);
  const settingsStatusesLoadedFor = useRef<string | null>(null);
  const [settingsBoardSetupMode, setSettingsBoardSetupMode] = useState<"existing" | "create">("existing");
  const [settingsTab, setSettingsTab] = useState<
    "workspace" | "board" | "code" | "agents" | "profiles" | "templates" | "automation" | "release-uat" | "release-prod" | "about" | "danger"
  >("workspace");
  const [aboutVersion, setAboutVersion] = useState("");
  useEffect(() => {
    void window.tandem.app.version().then((r) => {
      if (r.ok) setAboutVersion(r.data);
    });
  }, []);
  const workspace = activeWorkspace(draft) ?? draft.workspaces[0];
  const [githubProjectCreating, setGithubProjectCreating] = useState(false);
  const [newGithubProjectOwner, setNewGithubProjectOwner] = useState(workspace?.githubOwner ?? "");
  const [newGithubProjectTitle, setNewGithubProjectTitle] = useState(workspace?.name ?? "Twindem delivery");
  const activeWorkflowKey = workspace?.workflowTemplate ?? "default";
  const activeWorkflow = draft.workflows[activeWorkflowKey] ?? draft.workflows.default;
  const providerCount = Object.keys(draft.providers).length;

  useEffect(() => {
    setNewGithubProjectOwner(workspace?.githubOwner ?? "");
    setNewGithubProjectTitle(workspace?.name ?? "Twindem delivery");
  }, [workspace?.name, workspace?.githubOwner]);

  // One-shot auto-load of the project's Jira statuses when the Board tab is open for a Jira project
  // with a usable token. Guarded per project key so it doesn't refetch or loop on error.
  useEffect(() => {
    if (settingsTab !== "board") return;
    if (boardTypeForWorkspace(draft, workspace) !== "jira") return;
    const projectKey = workspace?.jiraProjectKey?.trim();
    if (!projectKey || !workspace) return;
    const hasToken = Boolean(workspace.jiraApiTokenSecretRef) || Boolean(settingsJiraApiToken.trim());
    if (!hasToken) return;
    const marker = `${workspace.name}:${projectKey}`;
    if (settingsStatusesLoadedFor.current === marker) return;
    settingsStatusesLoadedFor.current = marker;
    void loadSettingsJiraStatuses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsTab, workspace?.name, workspace?.jiraProjectKey, workspace?.jiraApiTokenSecretRef]);

  const rolesIssue = rolePartitionIssue(
    rolesFromPaneDefault(draft.defaults.leftPane),
    rolesFromPaneDefault(draft.defaults.rightPane),
    Object.keys(draft.roles)
  );
  const settingsTabs = [
    { key: "workspace", label: "Project", meta: workspace?.root ? workspace.root : "Local folder" },
    {
      key: "board",
      label: "Board",
      meta:
        boardTypeForWorkspace(draft, workspace) === "jira"
          ? workspace?.jiraProjectKey ? `Jira ${workspace.jiraProjectKey}` : "Jira"
          : boardTypeForWorkspace(draft, workspace) === "none"
            ? "Local only"
            : workspace?.githubOwner && workspace?.projectNumber ? `${workspace.githubOwner} #${workspace.projectNumber}` : "Project sync"
    },
    {
      key: "code",
      label: "Code/Repo",
      meta: (workspace?.allowedRepoPaths ?? []).length > 0 ? `${(workspace?.allowedRepoPaths ?? []).length} path(s)` : "Workspace root"
    },
    { key: "agents", label: "Active agents", meta: `${agentDisplayName(draft, draft.defaults.leftPane.provider, "L")} + ${agentDisplayName(draft, draft.defaults.rightPane.provider, "R")}` },
    { key: "profiles", label: "Profiles", meta: `${providerCount} saved` },
    { key: "templates", label: "Templates", meta: activeWorkflowKey },
    { key: "automation", label: "Automation", meta: normalizeAutomation(draft.defaults.automationLevel) },
    { key: "release-uat", label: "Release in UAT", meta: workspace?.uatReleaseInstructions?.trim() ? "configured ✓" : "empty" },
    { key: "release-prod", label: "Release in Production", meta: workspace?.prodReleaseInstructions?.trim() ? "configured ✓" : "empty" },
    { key: "about", label: "About", meta: "Apache-2.0" },
    { key: "danger", label: "Delete Project", meta: "" }
  ] as const;

  function updateWorkspace(patch: Partial<TandemConfig["workspaces"][number]>) {
    setDraft((prev) => {
      const index = Math.max(0, prev.workspaces.findIndex((candidate) => candidate.name === prev.defaults.workspaceName));
      const workspaces = [...prev.workspaces];
      workspaces[index] = { ...workspaces[index], ...patch };
      return {
        ...prev,
        workspaces,
        defaults: { ...prev.defaults, workspaceName: workspaces[index].name }
      };
    });
  }

  function updateBoardType(next: BoardType) {
    setSettingsJiraCheck(null);
    setDraft((prev) => {
      const index = Math.max(0, prev.workspaces.findIndex((candidate) => candidate.name === prev.defaults.workspaceName));
      const workspaces = [...prev.workspaces];
      workspaces[index] = {
        ...workspaces[index],
        boardProvider: next === "github" ? "github_project" : next
      };
      return {
        ...prev,
        workspaces,
        defaults: { ...prev.defaults, boardType: next, workspaceName: workspaces[index].name }
      };
    });
  }

  function selectWorkspace(name: string) {
    setDraft((prev) => ({ ...prev, defaults: { ...prev.defaults, workspaceName: name } }));
  }

  function addProject() {
    setDraft((prev) => {
      const name = uniqueWorkspaceName(prev, "New project");
      const workspaceTemplate = prev.workspaces[0];
      return {
        ...prev,
        workspaces: [
          ...prev.workspaces,
          {
            name,
            root: "",
            githubOwner: workspaceTemplate?.githubOwner,
            projectNumber: workspaceTemplate?.projectNumber,
            issueRepository: undefined,
            allowedRepoPaths: [],
            projectLayout: [],
            uatDeployArgs: [],
            workflowTemplate: workspaceTemplate?.workflowTemplate ?? "default",
            statusMapping: workspaceTemplate?.statusMapping ?? defaultWorkspaceStatusMapping
          }
        ],
        defaults: { ...prev.defaults, workspaceName: name }
      };
    });
  }

  function removeWorkspace() {
    setDraft((prev) => {
      if (prev.workspaces.length <= 1) return prev;
      const currentName = prev.defaults.workspaceName;
      const workspaces = prev.workspaces.filter((candidate) => candidate.name !== currentName);
      return {
        ...prev,
        workspaces,
        defaults: { ...prev.defaults, workspaceName: workspaces[0]?.name }
      };
    });
  }

  async function browseWorkspaceRoot() {
    try {
      const picked = await unwrap(window.tandem.config.pickDirectory());
      if (picked) updateWorkspace({ root: picked });
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadGithubProjects() {
    setGithubProjectsLoading(true);
    try {
      const projects = await unwrap(window.tandem.board.listProjects());
      setGithubProjects(projects);
      if (!workspace?.githubOwner && !workspace?.projectNumber && projects[0]) {
        updateWorkspace({ githubOwner: projects[0].owner, projectNumber: projects[0].number });
      }
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setGithubProjectsLoading(false);
    }
  }

  async function loadGithubProjectOwners() {
    try {
      const owners = await unwrap(window.tandem.board.listProjectOwners());
      setGithubProjectOwners(owners);
      if (!newGithubProjectOwner.trim() && owners[0]) setNewGithubProjectOwner(owners[0].login);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function connectAndLoadGithub() {
    try {
      await onCheckGithub();
      const status = await unwrap(window.tandem.board.authStatus());
      if (status.ok) {
        await loadGithubProjectOwners();
        await loadGithubProjects();
      }
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function createSettingsGithubProject() {
    setGithubProjectCreating(true);
    setSettingsError(null);
    try {
      const project = await unwrap(
        window.tandem.board.createProject(
          newGithubProjectOwner.trim() || workspace?.githubOwner?.trim() || "@me",
          newGithubProjectTitle.trim() || workspace?.name || "Twindem delivery"
        )
      );
      setGithubProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
      setNewGithubProjectOwner(project.owner);
      setNewGithubProjectTitle(project.title);
      updateWorkspace({ githubOwner: project.owner, projectNumber: project.number });
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setGithubProjectCreating(false);
    }
  }

  // Settings has two token sources: a freshly-typed token (creds path) or a previously saved one
  // (workspace path — read in main from safeStorage, never reloaded into the renderer).
  function settingsJiraCredsOrNull() {
    const token = settingsJiraApiToken.trim();
    if (!token) return null;
    return { siteUrl: workspace?.jiraSiteUrl ?? "", email: workspace?.jiraEmail ?? "", apiToken: token };
  }

  async function checkSettingsJira() {
    if (!workspace) return;
    setSettingsError(null);
    setSettingsJiraCheck(null);
    const typed = settingsJiraApiToken.trim();
    if (!typed && !workspace.jiraApiTokenSecretRef) {
      setSettingsJiraCheck({ ok: false, message: "Paste a Jira API token before authenticating." });
      return;
    }
    try {
      if (typed) {
        const status = await unwrap(
          window.tandem.board.validateJira({
            siteUrl: workspace.jiraSiteUrl ?? "",
            email: workspace.jiraEmail ?? "",
            apiToken: typed
          })
        );
        setSettingsJiraCheck(status);
        if (status.ok) await loadSettingsJiraProjects();
      } else {
        // Saved-token path: validate by listing projects in main (token read from safeStorage —
        // never reloaded into the renderer). A successful list IS the auth check.
        await loadSettingsJiraProjects();
        setSettingsJiraCheck({ ok: true, message: "Using saved Jira token." });
      }
    } catch (error) {
      setSettingsJiraCheck({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function loadSettingsJiraProjects() {
    if (!workspace) return;
    setSettingsJiraProjectsLoading(true);
    try {
      const creds = settingsJiraCredsOrNull();
      const projects = creds
        ? await unwrap(window.tandem.jira.listProjects(creds))
        : await unwrap(window.tandem.jira.listProjectsForWorkspace(workspace.name));
      setSettingsJiraProjects(projects);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingsJiraProjectsLoading(false);
    }
  }

  async function loadSettingsJiraStatuses() {
    if (!workspace) return;
    const projectKey = workspace.jiraProjectKey?.trim();
    if (!projectKey) {
      setSettingsJiraStatusesError("Pick a Jira project first.");
      return;
    }
    setSettingsJiraStatusesLoading(true);
    setSettingsJiraStatusesError(null);
    try {
      const creds = settingsJiraCredsOrNull();
      const issueType = workspace.jiraIssueType?.trim() || undefined;
      const result = creds
        ? await unwrap(window.tandem.jira.listProjectStatuses(creds, projectKey, issueType))
        : await unwrap(window.tandem.jira.listProjectStatusesForWorkspace(workspace.name, projectKey, issueType));
      setSettingsJiraStatuses(result.statuses);
      setSettingsJiraStatusesUnioned(result.unioned);
      // Auto-map, preserving the user's existing overrides; fills only gaps.
      const existing = workspace.statusMapping ?? defaultWorkspaceStatusMapping;
      const write = autoMapWrite(result.statuses, existing.write);
      const read = autoMapRead(result.statuses, write, existing.read, existing.ignored ?? []);
      updateWorkspace({ statusMapping: { write, read, ignored: existing.ignored ?? [] } });
    } catch (error) {
      setSettingsJiraStatuses([]);
      setSettingsJiraStatusesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingsJiraStatusesLoading(false);
    }
  }

  async function createSettingsJiraProject(key: string, name: string) {
    if (!workspace) return;
    const dupe = settingsJiraProjects.find(
      (p) => p.key.trim().toUpperCase() === key.trim().toUpperCase() || p.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    if (dupe) {
      setSettingsError(
        `A Jira project already exists with that ${dupe.key.trim().toUpperCase() === key.trim().toUpperCase() ? `key "${key}"` : `name "${name}"`} (${dupe.key}). Select it from the list, or use a different key/name.`
      );
      return;
    }
    setSettingsJiraCreating(true);
    setSettingsError(null);
    try {
      const creds = settingsJiraCredsOrNull();
      const project = creds
        ? await unwrap(window.tandem.jira.createProject(creds, { key, name }))
        : await unwrap(window.tandem.jira.createProjectForWorkspace(workspace.name, { key, name }));
      setSettingsJiraProjects((current) => [project, ...current.filter((candidate) => candidate.id !== project.id)]);
      updateWorkspace({ jiraProjectKey: project.key, boardProvider: "jira" });
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSettingsJiraCreating(false);
    }
  }

  function updateSettingsJiraSiteInput(value: string) {
    const parsed = parseJiraBoardUrl(value);
    updateWorkspace({
      jiraSiteUrl: parsed.siteUrl || undefined,
      jiraProjectKey: parsed.projectKey ?? workspace?.jiraProjectKey,
      jiraBoardId: parsed.boardId ?? workspace?.jiraBoardId,
      boardProvider: "jira"
    });
  }

  function updatePane(side: "leftPane" | "rightPane", patch: Partial<TandemConfig["defaults"]["leftPane"]>) {
    setDraft((prev) => ({
      ...prev,
      defaults: {
        ...prev.defaults,
        [side]: { ...prev.defaults[side], ...patch }
      }
    }));
  }

  function updateDefaultPaneRoles(side: AgentSide, requestedRoles: string[]) {
    setDraft((prev) => {
      const allRoles = Object.keys(prev.roles);
      const partition = partitionRolesForSide(
        side,
        requestedRoles,
        rolesFromPaneDefault(prev.defaults.leftPane),
        rolesFromPaneDefault(prev.defaults.rightPane),
        allRoles
      );
      return {
        ...prev,
        defaults: {
          ...prev.defaults,
          leftPane: {
            ...prev.defaults.leftPane,
            role: partition.L[0],
            roles: partition.L
          },
          rightPane: {
            ...prev.defaults.rightPane,
            role: partition.R[0],
            roles: partition.R
          }
        }
      };
    });
  }

  function updateProvider(key: string, patch: Partial<TandemConfig["providers"][string]>) {
    setDraft((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [key]: { ...prev.providers[key], ...patch }
      }
    }));
  }

  function updateInstructionTemplate(key: string, value: string) {
    setDraft((prev) => {
      const workflowKey = activeWorkflowKey;
      const workflow = prev.workflows[workflowKey] ?? prev.workflows.default;
      return {
        ...prev,
        workflows: {
          ...prev.workflows,
          [workflowKey]: {
            ...workflow,
            instructionTemplates: {
              ...(workflow?.instructionTemplates ?? {}),
              [key]: value
            }
          }
        }
      };
    });
  }

  function addProvider() {
    setDraft((prev) => {
      const key = uniqueProviderKey(prev, "agent");
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [key]: {
            label: "New agent profile",
            command: "codex",
            args: [],
            resumeArgs: [],
            model: "custom",
            supportsResume: true
          }
        }
      };
    });
  }

  function duplicateProvider(key: string) {
    setDraft((prev) => {
      const provider = prev.providers[key];
      if (!provider) return prev;
      const nextKey = uniqueProviderKey(prev, key);
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [nextKey]: {
            ...provider,
            label: `${provider.label} copy`
          }
        }
      };
    });
  }

  function removeProvider(key: string) {
    setDraft((prev) => {
      if (Object.keys(prev.providers).length <= 1) return prev;
      const providers = { ...prev.providers };
      delete providers[key];
      const fallback = Object.keys(providers)[0];
      return {
        ...prev,
        providers,
        defaults: {
          ...prev.defaults,
          leftPane: {
            ...prev.defaults.leftPane,
            provider: prev.defaults.leftPane.provider === key ? fallback : prev.defaults.leftPane.provider
          },
          rightPane: {
            ...prev.defaults.rightPane,
            provider: prev.defaults.rightPane.provider === key ? fallback : prev.defaults.rightPane.provider
          }
        }
      };
    });
  }

  function validateDraft(): string | null {
    const missingRoot = draft.workspaces.find((item) => !item.root.trim());
    if (missingRoot) return `Project "${missingRoot.name}" needs a local folder.`;
    const missingCommand = Object.entries(draft.providers).find(([, provider]) => !provider.command.trim());
    if (missingCommand) return `Agent profile "${missingCommand[0]}" needs a command.`;
    const missingSecret = Object.entries(draft.providers).find(([key, provider]) => {
      if (provider.authMode !== "api_key") return false;
      return !provider.apiKeySecretRef && !profileApiKeys[key]?.trim();
    });
    if (missingSecret) return `Agent profile "${missingSecret[0]}" is set to API key auth but has no saved key.`;
    const roleIssue = rolePartitionIssue(
      rolesFromPaneDefault(draft.defaults.leftPane),
      rolesFromPaneDefault(draft.defaults.rightPane),
      Object.keys(draft.roles)
    );
    if (roleIssue) return roleIssue;
    const activeWs = activeWorkspace(draft);
    const activeBoardType = boardTypeForWorkspace(draft, activeWs);
    if (activeBoardType === "none") {
      return "Choose Jira or GitHub. Twindem needs a board as the source of truth.";
    }
    if (activeBoardType === "github" && (!activeWs?.githubOwner?.trim() || !activeWs.projectNumber)) {
      return "Choose or create a GitHub Project board.";
    }
    if (activeBoardType === "jira") {
      if (!activeWs?.jiraSiteUrl?.trim() || !activeWs.jiraProjectKey?.trim() || !activeWs.jiraEmail?.trim()) {
        return "Jira board requires site URL, project key, and account email.";
      }
      if (!activeWs.jiraApiTokenSecretRef && !settingsJiraApiToken.trim()) {
        return "Jira board requires an API token. Paste it once; Twindem stores it encrypted.";
      }
    }
    return null;
  }

  async function importConfig() {
    try {
      const imported = await unwrap(window.tandem.config.importFile());
      if (imported) setDraft(imported);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function exportConfig() {
    try {
      const error = validateDraft();
      if (error) {
        setSettingsError(error);
        return;
      }
      const path = await unwrap(window.tandem.config.exportFile(draft));
      if (path) setSettingsError(`Exported to ${path}`);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveDraft() {
    const error = validateDraft();
    if (error) {
      setSettingsError(error);
      return;
    }
    let nextDraft = draft;
    for (const workspace of nextDraft.workspaces) {
      const folderCheck = await unwrap(window.tandem.config.validateDirectory(workspace.root));
      if (!folderCheck.ok) {
        setSettingsError(`Project "${workspace.name}": ${folderCheck.message}`);
        return;
      }
    }
    for (const [key, value] of Object.entries(profileApiKeys)) {
      if (!value.trim()) continue;
      const provider = draft.providers[key];
      const secretRef = provider?.apiKeySecretRef ?? agentProfileApiKeySecretRef(key);
      const envName = provider?.apiKeyEnv ?? apiKeyEnvForCommand(provider?.command ?? "");
      const keyCheck = await unwrap(window.tandem.secrets.validateAgentApiKey(envName ?? "", value));
      if (!keyCheck.ok) {
        setSettingsError(keyCheck.message);
        return;
      }
      await unwrap(window.tandem.secrets.setAgentApiKey(secretRef, value));
      nextDraft = {
        ...nextDraft,
        providers: {
          ...nextDraft.providers,
          [key]: {
            ...nextDraft.providers[key],
            apiKeySecretRef: secretRef
          }
        }
      };
    }
    const activeWs = activeWorkspace(nextDraft);
    const activeBoardType = boardTypeForWorkspace(nextDraft, activeWs);
    if (activeBoardType === "jira" && activeWs && settingsJiraApiToken.trim()) {
      const status = await unwrap(
        window.tandem.board.validateJira({
          siteUrl: activeWs.jiraSiteUrl ?? "",
          email: activeWs.jiraEmail ?? "",
          apiToken: settingsJiraApiToken
        })
      );
      setSettingsJiraCheck(status);
      if (!status.ok) {
        setSettingsError(status.message);
        return;
      }
      const secretRef = activeWs.jiraApiTokenSecretRef ?? jiraApiTokenSecretRef(activeWs.name);
      await unwrap(window.tandem.secrets.set(secretRef, settingsJiraApiToken));
      nextDraft = {
        ...nextDraft,
        workspaces: nextDraft.workspaces.map((candidate) =>
          candidate.name === activeWs.name ? { ...candidate, jiraApiTokenSecretRef: secretRef } : candidate
        )
      };
    }
    await onSave(nextDraft);
  }

  async function handleDeleteProject() {
    if (!workspace) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await window.tandem.config.deleteProject(workspace.name);
      if (!result.ok) {
        setDeleteError(result.error.message);
        setDeleting(false);
        setDeleteConfirm(false);
        return;
      }
      setDeleteConfirm(false);
      await onProjectDeleted(workspace.name, result.data.deletedSessions);
      // The dialog is closed by the parent after this; no need to reset state.
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
      setDeleting(false);
      setDeleteConfirm(false);
    }
  }

  return (
    <div className="modal-backdrop">
      {deleteConfirm && !deleting && (
        <div className="modal-backdrop nested">
          <section className="confirm-dialog danger-dialog">
            <h2>Delete “{workspace?.name}”?</h2>
            <p>
              This permanently removes <strong>all local data</strong> for this project — every task, its history,
              evidence, and cache. <strong>It cannot be undone.</strong>
            </p>
            <p className="confirm-note">Nothing on the remote board (Jira / GitHub) will be deleted.</p>
            <div className="footer-actions">
              <button onClick={() => setDeleteConfirm(false)}>Cancel</button>
              <button className="danger" onClick={() => void handleDeleteProject()}>Yes, delete everything</button>
            </div>
          </section>
        </div>
      )}
      {deleting && (
        <div className="modal-backdrop nested">
          <section className="confirm-dialog">
            <TwindemLoader size={48} />
            <h2>Deleting all project files…</h2>
            <p className="confirm-note">Removing local tasks, history and cache. The remote board is untouched.</p>
          </section>
        </div>
      )}
      <section className="settings-dialog refined">
        <header>
          <div>
            <span className="eyebrow">Settings</span>
            <h2>Twindem configuration</h2>
            <p>Projects, board sync, agent defaults, model profiles and instruction templates.</p>
          </div>
          <button onClick={onCancel}>Close</button>
        </header>

        <div className="settings-shell">
          <aside className="settings-nav" aria-label="Settings sections">
            {settingsTabs.map((tab) => (
              <button
                key={tab.key}
                className={`${settingsTab === tab.key ? "active" : ""}${tab.key === "danger" ? " settings-nav-danger" : ""}`}
                onClick={() => setSettingsTab(tab.key)}
              >
                <span>{tab.label}</span>
                <small>{tab.meta}</small>
              </button>
            ))}
          </aside>

          <div className="settings-content">
          {settingsError && (
            <div className="settings-error">
              <span>{settingsError}</span>
              <button onClick={() => setSettingsError(null)}>Dismiss</button>
            </div>
          )}

          {settingsTab === "workspace" && (
            <section className="settings-section active">
              <div className="section-title-row">
                <div>
                  <h3>Project</h3>
                  <p className="section-note">A Twindem project combines a local folder, board, agents, and release runbooks.</p>
                </div>
                <div className="inline-actions">
                  <button onClick={addProject}>Add project</button>
                  <button onClick={removeWorkspace} disabled={draft.workspaces.length <= 1}>
                    Remove
                  </button>
                </div>
              </div>
              <label className="workspace-picker full">
                Active project
                <select value={draft.defaults.workspaceName ?? workspace?.name ?? ""} onChange={(event) => selectWorkspace(event.target.value)}>
                  {draft.workspaces.map((candidate) => (
                    <option key={candidate.name} value={candidate.name}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="settings-grid">
                <label>
                  Name
                  <input value={workspace?.name ?? ""} onChange={(event) => updateWorkspace({ name: event.target.value })} />
                </label>
                <label>
                  Local folder
                  <span className="inline-field">
                    <input value={workspace?.root ?? ""} onChange={(event) => updateWorkspace({ root: event.target.value })} />
                    <button onClick={() => void browseWorkspaceRoot()}>Browse</button>
                  </span>
                </label>
              </div>
              <label className="full">
                Principal repo <span className="field-optional">(root code — separate from the board's issue repo)</span>
                <RepoField
                  value={workspace?.principalRepo ? { owner: workspace.principalRepo.owner, name: workspace.principalRepo.name } : undefined}
                  adoptPath={workspace?.root?.trim() || undefined}
                  onChange={(repo) => updateWorkspace({ principalRepo: repo ? { owner: repo.owner, name: repo.name, path: "" } : undefined })}
                  onNotice={(m) => setSettingsError(m)}
                />
                <small className="field-hint">
                  Root code repo + catch-all for code that fits no component. Adopt the folder's repo, browse your
                  GitHub, or create one. NOT the board's tracking-issue repo.
                </small>
              </label>
              <label className="full">
                Project layout <span className="field-optional">(components — optional)</span>
                <ProjectLayoutEditor
                  value={workspace?.projectLayout ?? []}
                  onChange={(next) => updateWorkspace({ projectLayout: next })}
                  root={workspace?.root}
                  onNotice={(m) => setSettingsError(m)}
                />
                <small className="field-hint">
                  Where each part lives — Browse picks/creates a folder under the project root. Set a repo per row only
                  for polyrepo (its own git repo); empty = part of the principal/monorepo. Injected into the agents'
                  brief + allowed implementation scope.
                </small>
              </label>
              <div className="settings-grid">
                <label>
                  UAT deploy command
                  <input
                    value={workspace?.uatDeployCommand ?? ""}
                    onChange={(event) => updateWorkspace({ uatDeployCommand: event.target.value || undefined })}
                    placeholder="gh"
                  />
                </label>
                <label>
                  UAT deploy args
                  <input
                    value={(workspace?.uatDeployArgs ?? []).join(" ")}
                    onChange={(event) => updateWorkspace({ uatDeployArgs: splitArgs(event.target.value) })}
                    placeholder="workflow run deploy-uat.yml --ref master"
                  />
                </label>
              </div>
            </section>
          )}

          {settingsTab === "board" && (
            <section className="settings-section active">
              <div className="section-title-row">
                <div>
                  <h3>Board provider</h3>
                  <p className="section-note">The board is the source of truth. Implementation scope stays controlled by the local project folder.</p>
                </div>
              </div>
              <BoardSetupFields
                value={{
                  boardType: boardTypeForWorkspace(draft, workspace),
                  boardSetupMode: settingsBoardSetupMode,
                  githubOwner: workspace?.githubOwner ?? "",
                  projectNumber: workspace?.projectNumber ? String(workspace.projectNumber) : "",
                  issueRepository: workspace?.issueRepository ?? "",
                  newBoardTitle: newGithubProjectTitle,
                  jiraSiteUrl: workspace?.jiraSiteUrl ?? "",
                  jiraEmail: workspace?.jiraEmail ?? "",
                  jiraApiToken: settingsJiraApiToken,
                  jiraProjectKey: workspace?.jiraProjectKey ?? "",
                  jiraIssueType: workspace?.jiraIssueType ?? "Task"
                }}
                onChange={(patch) => {
                  if (patch.boardType !== undefined) updateBoardType(patch.boardType);
                  if (patch.boardSetupMode !== undefined) setSettingsBoardSetupMode(patch.boardSetupMode);
                  if (patch.githubOwner !== undefined) updateWorkspace({ githubOwner: patch.githubOwner.trim() || undefined });
                  if (patch.projectNumber !== undefined) updateWorkspace({ projectNumber: Number(patch.projectNumber) || undefined });
                  if (patch.issueRepository !== undefined) updateWorkspace({ issueRepository: patch.issueRepository.trim() || undefined });
                  if (patch.newBoardTitle !== undefined) setNewGithubProjectTitle(patch.newBoardTitle);
                  if (patch.jiraSiteUrl !== undefined) updateSettingsJiraSiteInput(patch.jiraSiteUrl);
                  if (patch.jiraEmail !== undefined) updateWorkspace({ jiraEmail: patch.jiraEmail.trim() || undefined, boardProvider: "jira" });
                  if (patch.jiraApiToken !== undefined) setSettingsJiraApiToken(patch.jiraApiToken);
                  if (patch.jiraProjectKey !== undefined) updateWorkspace({ jiraProjectKey: patch.jiraProjectKey.toUpperCase() || undefined, boardProvider: "jira" });
                  if (patch.jiraIssueType !== undefined) updateWorkspace({ jiraIssueType: patch.jiraIssueType || "Task", boardProvider: "jira" });
                }}
                github={{
                  projects: githubProjects,
                  owners: githubProjectOwners,
                  loading: githubProjectsLoading,
                  creating: githubProjectCreating,
                  checking: githubAuthChecking || githubProjectsLoading,
                  check: githubAuthStatus,
                  onConnect: () => void connectAndLoadGithub(),
                  onRefresh: () => void loadGithubProjects(),
                  onCreateProject: () => void createSettingsGithubProject()
                }}
                jira={{
                  projects: settingsJiraProjects,
                  loading: settingsJiraProjectsLoading,
                  creating: settingsJiraCreating,
                  authChecking: false,
                  authed: Boolean(settingsJiraCheck?.ok) || Boolean(workspace?.jiraApiTokenSecretRef),
                  check: settingsJiraCheck,
                  tokenSavedHint: Boolean(workspace?.jiraApiTokenSecretRef),
                  onAuthenticate: () => void checkSettingsJira(),
                  onRefreshProjects: () => void loadSettingsJiraProjects(),
                  onCreateProject: (key, name) => void createSettingsJiraProject(key, name)
                }}
                helpTopic={settingsBoardHelpTopic}
                onHelpTopicChange={setSettingsBoardHelpTopic}
                workspaceName={workspace?.name}
              />
              {boardTypeForWorkspace(draft, workspace) === "jira" && workspace?.jiraProjectKey && (
                <div className="settings-subsection">
                  <div className="section-title-row">
                    <div>
                      <h3>Status mapping</h3>
                      <p className="section-note">
                        Map this board's real statuses to Twindem's workflow steps. Every status must map to a
                        step or be marked outside the workflow.
                      </p>
                    </div>
                  </div>
                  <StatusMappingEditor
                    statuses={settingsJiraStatuses}
                    value={{
                      write: { ...(workspace.statusMapping?.write ?? defaultWorkspaceStatusMapping.write) },
                      read: { ...(workspace.statusMapping?.read ?? {}) },
                      ignored: [...(workspace.statusMapping?.ignored ?? [])]
                    }}
                    onChange={(next) =>
                      updateWorkspace({ statusMapping: { write: next.write, read: next.read, ignored: next.ignored } })
                    }
                    loading={settingsJiraStatusesLoading}
                    onRefresh={() => void loadSettingsJiraStatuses()}
                    error={settingsJiraStatusesError}
                    unioned={settingsJiraStatusesUnioned}
                  />
                </div>
              )}
            </section>
          )}

          {settingsTab === "code" && (
            <section className="settings-section active">
              <div className="section-title-row">
                <div>
                  <h3>Code / Repo</h3>
                  <p className="section-note">Where agents may inspect and edit code — independent of the board provider.</p>
                </div>
              </div>
              <label className="full">
                Allowed implementation repos / paths <span className="field-optional">(optional)</span>
                <textarea
                  rows={4}
                  value={(workspace?.allowedRepoPaths ?? []).join("\n")}
                  onChange={(event) =>
                    updateWorkspace({
                      allowedRepoPaths: event.target.value
                        .split(/\r?\n/)
                        .map((item) => item.trim())
                        .filter(Boolean)
                    })
                  }
                  placeholder={"Most projects: leave empty.\nAdd a path only if code lives outside the project folder, e.g.\n/Users/you/dev/other-repo"}
                />
                <small className="field-hint">
                  Leave empty and agents work inside your project folder only. Add paths (one per line) only
                  if this project's code spans extra local folders/repos — e.g. a separate backend repo.
                </small>
              </label>
            </section>
          )}

          {settingsTab === "agents" && (
            <section className="settings-section active">
              <div className="section-title-row">
                <div>
                  <h3>Active agents</h3>
                  <p className="section-note">Exactly two panes are active by default. Roles are partitioned so one role belongs to only one side.</p>
                </div>
                {rolesIssue ? <span className="config-warning">Roles incomplete</span> : <span className="config-ok">Roles covered</span>}
              </div>
              <div className="settings-grid two">
                <PaneDefaultEditor
                  title={agentDisplayName(draft, draft.defaults.leftPane.provider, "L")}
                  pane={draft.defaults.leftPane}
                  config={draft}
                  allowEmptyRoles
                  onChange={(patch) => {
                    if (patch.roles) updateDefaultPaneRoles("L", patch.roles);
                    else updatePane("leftPane", patch);
                  }}
                />
                <PaneDefaultEditor
                  title={agentDisplayName(draft, draft.defaults.rightPane.provider, "R")}
                  pane={draft.defaults.rightPane}
                  config={draft}
                  allowEmptyRoles
                  onChange={(patch) => {
                    if (patch.roles) updateDefaultPaneRoles("R", patch.roles);
                    else updatePane("rightPane", patch);
                  }}
                />
              </div>
            </section>
          )}

          {settingsTab === "profiles" && (
            <section className="settings-section active">
              <div className="section-title-row">
                <div>
                  <h3>Agent profile library</h3>
                  <p className="section-note">Saved CLI/model profiles that can be assigned to either active pane.</p>
                </div>
                <button onClick={addProvider}>Add profile</button>
              </div>
              <div className="provider-list">
                {Object.entries(draft.providers).map(([key, provider]) => (
                  <div className="provider-editor" key={key}>
                    <div className="provider-editor-head">
                      <span className={`provider-icon ${providerFamily(provider)}`}>{providerInitial(provider)}</span>
                      <div>
                        <strong>{provider.label || key}</strong>
                        <small>{key}</small>
                      </div>
                      <span className="model-chip">{provider.model ?? provider.version ?? "default"}</span>
                    </div>
                    <div className="provider-command-preview">
                      {[provider.command, ...provider.args].filter(Boolean).join(" ") || "No command configured"}
                    </div>
                    <div className="provider-editor-grid">
                      <label>
                        Label
                        <input value={provider.label} onChange={(event) => updateProvider(key, { label: event.target.value })} />
                      </label>
                      <label>
                        Model/version
                        <input
                          value={provider.model ?? provider.version ?? ""}
                          onChange={(event) => updateProvider(key, { model: event.target.value || undefined })}
                        />
                      </label>
                      <label>
                        Command
                        <input
                          value={provider.command}
                          onChange={(event) => updateProvider(key, { command: event.target.value })}
                        />
                      </label>
                      <label>
                        Args
                        <input
                          value={provider.args.join(" ")}
                          onChange={(event) => updateProvider(key, { args: splitArgs(event.target.value) })}
                          placeholder="--model gpt-5.5"
                        />
                      </label>
                      <label>
                        Auth
                        <select
                          value={provider.authMode ?? defaultAuthModeForCommand(provider.command)}
                          onChange={(event) => {
                            const authMode = event.target.value as AgentAuthMode;
                            updateProvider(key, {
                              authMode,
                              apiKeyEnv: authMode === "api_key" ? provider.apiKeyEnv ?? apiKeyEnvForCommand(provider.command) : provider.apiKeyEnv,
                              apiKeySecretRef:
                                authMode === "api_key" ? provider.apiKeySecretRef ?? agentProfileApiKeySecretRef(key) : provider.apiKeySecretRef
                            });
                          }}
                        >
                          <option value="subscription">Subscription login</option>
                          <option value="api_key">API key</option>
                          <option value="none">No auth</option>
                        </select>
                      </label>
                      <label>
                        API key env
                        <input
                          value={provider.apiKeyEnv ?? apiKeyEnvForCommand(provider.command) ?? ""}
                          onChange={(event) => updateProvider(key, { apiKeyEnv: event.target.value || undefined })}
                          placeholder="OPENAI_API_KEY"
                          disabled={(provider.authMode ?? "subscription") !== "api_key"}
                        />
                      </label>
                      {(provider.authMode ?? "subscription") === "api_key" && (
                        <label>
                          Replace API key
                          <input
                            type="password"
                            value={profileApiKeys[key] ?? ""}
                            onChange={(event) => {
                              const value = event.target.value;
                              setProfileApiKeys((current) => ({ ...current, [key]: value }));
                              if (!provider.apiKeySecretRef) {
                                updateProvider(key, { apiKeySecretRef: agentProfileApiKeySecretRef(key) });
                              }
                            }}
                            placeholder={provider.apiKeySecretRef ? "Saved. Leave blank to keep it." : "Paste API key"}
                          />
                        </label>
                      )}
                      {(providerFamily(provider) === "codex" || providerFamily(provider) === "claude") && (
                        <label className="checkbox-row">
                          <input
                            type="checkbox"
                            checked={Boolean(provider.dangerouslySkipPermissions)}
                            onChange={(event) => updateProvider(key, { dangerouslySkipPermissions: event.target.checked })}
                          />
                          Skip CLI permission prompts (dangerous)
                        </label>
                      )}
                      <label>
                        Resume command
                        <input
                          value={provider.resumeCommand ?? ""}
                          onChange={(event) => updateProvider(key, { resumeCommand: event.target.value || undefined })}
                          placeholder={provider.command}
                        />
                      </label>
                      <label>
                        Resume args
                        <input
                          value={(provider.resumeArgs ?? []).join(" ")}
                          onChange={(event) => updateProvider(key, { resumeArgs: splitArgs(event.target.value) })}
                          placeholder="resume --last"
                        />
                      </label>
                    </div>
                    <div className="provider-editor-actions">
                      <label className="checkbox-row compact">
                        <input
                          type="checkbox"
                          checked={provider.supportsResume}
                          onChange={(event) => updateProvider(key, { supportsResume: event.target.checked })}
                        />
                        Supports resume
                      </label>
                      <button onClick={() => duplicateProvider(key)}>Duplicate</button>
                      <button onClick={() => removeProvider(key)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {settingsTab === "templates" && (
            <section className="settings-section active">
              <div className="section-title-row">
                <div>
                  <h3>Instruction templates</h3>
                  <p className="section-note">Reusable prompts the conductor uses for handoff, planning, implementation, rework and deploy steps.</p>
                </div>
                <span className="context-pill">
                  <span>Workflow</span>
                  <strong>{activeWorkflowKey}</strong>
                </span>
              </div>
              <div className="template-editor-list">
                {["handoffReview", "planning", "implementation", "rework", "uatDeploy"].map((key) => (
                  <label key={key}>
                    {templateLabel(key)}
                    <textarea
                      value={activeWorkflow?.instructionTemplates?.[key] ?? ""}
                      onChange={(event) => updateInstructionTemplate(key, event.target.value)}
                    />
                  </label>
                ))}
              </div>
            </section>
          )}

          {settingsTab === "automation" && (
            <section className="settings-section active">
              <div className="section-title-row">
                <div>
                  <h3>Automation</h3>
                  <p className="section-note">Default automation posture for new sessions. Human gates still stop risky transitions.</p>
                </div>
              </div>
              <div className="automation-settings-grid">
                {(["manual", "auto"] as const).map((level) => (
                  <button
                    key={level}
                    className={draft.defaults.automationLevel === level ? "automation-choice selected" : "automation-choice"}
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        defaults: { ...prev.defaults, automationLevel: level }
                      }))
                    }
                  >
                    <strong>{automationLabel(level)}</strong>
                    <span>{automationDescription(level)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {(settingsTab === "release-uat" || settingsTab === "release-prod") && (
            <section className="settings-section active">
              <div className="section-title-row">
                <div>
                  <h3>{settingsTab === "release-uat" ? "Release in UAT" : "Release in Production"}</h3>
                  <p className="section-note">
                    Step-by-step runbook the Release Operator (Agent 2) follows when you click{" "}
                    {settingsTab === "release-uat" ? '"Move to UAT"' : '"Move to production"'}. Leave empty to keep
                    that step manual.
                  </p>
                </div>
              </div>
              <div className="release-sensitive-note">
                ⚠️ Sensitive data. These instructions are stored ONLY locally, in your Twindem config file on this
                machine — they are never uploaded or sent anywhere except to your local agent CLI at release time.
                If you prefer maximum safety, leave this empty and run the release steps manually.
              </div>
              <label className="release-instructions-label">
                {settingsTab === "release-uat" ? "UAT release instructions" : "Production release instructions"}
                <textarea
                  rows={14}
                  placeholder={"e.g.\n1. ssh into the target server\n2. copy the changed files / pull the release branch\n3. restart services\n4. verify the rollout on the live site"}
                  value={
                    (settingsTab === "release-uat" ? workspace?.uatReleaseInstructions : workspace?.prodReleaseInstructions) ?? ""
                  }
                  onChange={(event) =>
                    updateWorkspace(
                      settingsTab === "release-uat"
                        ? { uatReleaseInstructions: event.target.value }
                        : { prodReleaseInstructions: event.target.value }
                    )
                  }
                />
              </label>
            </section>
          )}

          {settingsTab === "about" && (
            <section className="settings-section active">
              <div className="section-title-row">
                <div>
                  <h3>About Twindem</h3>
                  <p className="section-note">Version, license, and open-source acknowledgements.</p>
                </div>
              </div>
              <AboutContent version={aboutVersion} />
            </section>
          )}

          {settingsTab === "danger" && (
            <section className="settings-section active">
              <div className="section-title-row">
                <div>
                  <h3 className="danger-title">Delete Project</h3>
                  <p className="section-note">
                    Permanently delete <strong>{workspace?.name}</strong> and ALL of its local data — every task/session,
                    its history, evidence, and the local cache. This cannot be undone.
                  </p>
                </div>
              </div>
              <div className="danger-zone">
                <p>
                  <strong>Nothing on the remote board (Jira / GitHub) is deleted</strong> — issues and comments stay there.
                  Your code folder is not touched either; only Twindem's local data for this project is removed.
                </p>
                {deleteError && <p className="task-proposal-error">{deleteError}</p>}
                <button className="danger" onClick={() => setDeleteConfirm(true)} disabled={deleting}>
                  Delete project
                </button>
              </div>
            </section>
          )}
          </div>
        </div>

        <footer>
          <button onClick={() => void importConfig()}>Import</button>
          <button onClick={() => void exportConfig()}>Export</button>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => void saveDraft()}>
            Save settings
          </button>
        </footer>
      </section>
    </div>
  );
}

function PaneDefaultEditor({
  title,
  pane,
  config,
  allowEmptyRoles = false,
  onChange
}: {
  title: string;
  pane: TandemConfig["defaults"]["leftPane"];
  config: TandemConfig;
  allowEmptyRoles?: boolean;
  onChange: (patch: Partial<TandemConfig["defaults"]["leftPane"]>) => void;
}) {
  return (
    <div className="pane-default-editor">
      <h4>{title}</h4>
      <RoleChecklist
        title="Roles"
        roles={rolesFromPaneDefault(pane)}
        allRoles={Object.keys(config.roles)}
        allowEmpty={allowEmptyRoles}
        onChange={(roles) => onChange({ role: roles[0], roles })}
      />
      <label>
        Model
        <select value={pane.provider} onChange={(event) => onChange({ provider: event.target.value })}>
          {Object.entries(config.providers).map(([key, provider]) => (
            <option key={key} value={key}>
              {providerDisplay(provider)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function CreateTaskDialog({
  config,
  detail,
  busy,
  onCancel,
  onCreate
}: {
  config: TandemConfig;
  detail: SessionDetail;
  busy: boolean;
  onCancel: () => void;
  onCreate: (repo: string, title: string) => void;
}) {
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  const provider = boardProviderForWorkspace(config, workspace);
  const workspaceRoot = workspace?.root ?? "";
  const isGithubBoard = provider === "github_project";
  const boardTarget =
    provider === "jira"
      ? workspace?.jiraProjectKey
        ? `Jira / ${workspace.jiraProjectKey}${workspace.name ? ` / ${workspace.name}` : ""}`
        : "Jira project not configured"
      : isGithubBoard
        ? workspace?.githubOwner && workspace.projectNumber
          ? `${workspace.githubOwner} / Project #${workspace.projectNumber}${workspace.name ? ` / ${workspace.name}` : ""}`
          : "GitHub Project board not configured"
        : "No board configured";
  const [repos, setRepos] = useState<GitHubRepoOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [repo, setRepo] = useState(detail.session.repo || (workspace?.issueRepository ? "__cross__" : ""));
  const [customRepo, setCustomRepo] = useState(workspace?.issueRepository ?? "");
  const [title, setTitle] = useState(detail.session.title ?? "");
  const useTrackingRepo = repo === "__cross__";
  const effectiveRepo = useTrackingRepo ? customRepo.trim() : repo.trim();

  useEffect(() => {
    if (!isGithubBoard) return;
    const root = workspaceRoot.trim();
    if (!root) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (!cancelled) setLoading(true);
      })
      .then(() => window.tandem.board.listWorkspaceRepos(root))
      .then((res) => {
        if (cancelled) return;
        const list = res.ok ? res.data : [];
        setRepos(list);
        setRepo((current) => current || (workspace?.issueRepository ? "__cross__" : list[0]?.fullName || ""));
        setCustomRepo((current) => current);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isGithubBoard, workspaceRoot, workspace?.githubOwner]);

  return (
    <div className="modal-backdrop">
      <section className="workflow-confirm">
        <header>
          <div>
            <span className="eyebrow">New task</span>
            <h2>Create board task</h2>
          </div>
          <button onClick={onCancel} disabled={busy}>Close</button>
        </header>
        <p>
          This creates a board task and links it as the source of truth.
          {isGithubBoard ? " Without a repository, Twindem creates a GitHub Project draft item." : ""}
        </p>
        <div className="create-task-board-target">
          <span>Will be added to</span>
          <strong>{boardTarget}</strong>
        </div>
        <label>
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" />
        </label>
        {isGithubBoard && (
          <>
            <label>
              Issue repository
              {repos.length > 0 ? (
                <select value={repo} onChange={(event) => setRepo(event.target.value)} disabled={busy}>
                  <option value="">Project draft item — no GitHub repo</option>
                  <option value="__cross__">Tracking issue in another repo — work stays local</option>
                  {repos.map((option) => (
                    <option key={option.fullName} value={option.fullName}>
                      {option.fullName}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="field-hint">
                  {loading ? "Detecting workspace repositories…" : "No workspace repos detected — Twindem will create a Project draft item."}
                </span>
              )}
            </label>
            {useTrackingRepo && (
              <label>
                Create the tracking issue in
                <input
                  value={customRepo}
                  onChange={(event) => setCustomRepo(event.target.value)}
                  placeholder={workspace?.githubOwner ? `${workspace.githubOwner}/repo-name` : "owner/repo"}
                  disabled={busy}
                />
                <small className="field-hint">
                  Optional. Use this only if you want a real GitHub issue. Leave it blank to create a Project draft item while agents work only inside the local workspace folder.
                </small>
              </label>
            )}
          </>
        )}
        {busy && (
          <div className="create-progress">
            <div className="create-progress-bar"><i /></div>
            <span>
              Creating the task on the board…{" "}
              {isGithubBoard
                ? `(${effectiveRepo ? "creating issue, adding to Project" : "creating Project draft item"}, setting Inbox)`
                : "(creating Jira issue)"}
            </span>
          </div>
        )}
        <footer>
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="primary"
            disabled={busy || (isGithubBoard && useTrackingRepo && Boolean(customRepo.trim()) && !/^[\w.-]+\/[\w.-]+$/.test(customRepo.trim())) || !title.trim()}
            onClick={() => onCreate(isGithubBoard ? effectiveRepo : "", title.trim())}
          >
            {busy ? "Creating…" : "Create task"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function NewSessionDialog({
  config,
  bugParent,
  onCancel,
  onCreate
}: {
  config: TandemConfig;
  bugParent?: { key: string; repo?: string; issueNumber?: number; title: string; url?: string } | null;
  onCancel: () => void;
  onCreate: (input: CreateSessionInput) => Promise<void>;
}) {
  // Entry points: a fresh idea, or picking an existing board issue. Bug is now an idea type,
  // not a top-level entry point; selecting Idea type = Bug shows the structured bug fields.
  const [entryKind, setEntryKind] = useState<"idea" | "bug" | "board">(bugParent ? "bug" : "idea");
  const artifactType: CreateSessionInput["artifactType"] = entryKind === "board" ? "issue" : "idea";
  const [ideaType, setIdeaType] = useState<IdeaType>(bugParent ? "bug" : "feature");
  const [taskReferences, setTaskReferences] = useState<Array<{ key: string; repo?: string; issueNumber?: number; title: string; url?: string }>>(
    bugParent ? [{ key: bugParent.key, repo: bugParent.repo, issueNumber: bugParent.issueNumber, title: bugParent.title, url: bugParent.url }] : []
  );
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState(config.defaults.workspaceName ?? config.workspaces[0]?.name ?? "");
  const [title, setTitle] = useState("");
  const [bugSummary, setBugSummary] = useState("");
  const [bugEnvironment, setBugEnvironment] = useState<"Local" | "UAT" | "PROD" | "Shared">("UAT");
  const [bugService, setBugService] = useState("");
  const [bugSteps, setBugSteps] = useState("1. \n2. \n3. ");
  const [bugExpected, setBugExpected] = useState("");
  const [bugActual, setBugActual] = useState("");
  const [bugEvidence, setBugEvidence] = useState("");
  const [bugVerification, setBugVerification] = useState("");
  const [sessionAutomation, setSessionAutomation] = useState<AutomationLevel>("auto");
  const [dangerouslySkipPermissions, setDangerouslySkipPermissions] = useState(false);
  // Files (images, zips with proposed designs, diagrams) the agents should inspect locally.
  const [attachments, setAttachments] = useState<string[]>([]);
  // Creating a session from a board issue syncs it from GitHub (4-5s) — show a loading overlay so
  // it doesn't look stuck.
  const [submitting, setSubmitting] = useState(false);
  // Quick-note: jot a short note now, flesh it out later. Only for Idea/Bug.
  const [quickNote, setQuickNote] = useState(false);
  const quickAllowed = entryKind === "idea" || entryKind === "bug";
  const quickActive = quickNote && quickAllowed;
  const selectedIdeaType = ideaTypeDefinition(ideaType);

  async function addAttachments() {
    // Open the file dialog in the project folder so attaching a design/file starts where the work is.
    const projectRoot = activeWorkspace(config, workspaceName)?.root?.trim() || undefined;
    const picked = await window.tandem.config.pickFiles(projectRoot).catch(() => null);
    if (picked?.ok && picked.data) {
      setAttachments((current) => Array.from(new Set([...current, ...picked.data!])));
    }
  }
  const [repo, setRepo] = useState("");
  const [repoOptions, setRepoOptions] = useState<GitHubRepoOption[]>([]);
  const [repoLoading, setRepoLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [issueNumber, setIssueNumber] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [selectedBoardArtifact, setSelectedBoardArtifact] = useState<BoardArtifactOption | null>(null);
  const [boardArtifacts, setBoardArtifacts] = useState<BoardArtifactOption[]>([]);
  const [boardQuery, setBoardQuery] = useState("");
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [selectedBoardStatus, setSelectedBoardStatus] = useState("All");
  const activeProjectName = config.defaults.workspaceName ?? config.workspaces[0]?.name ?? "";
  const selectedWorkspace = activeWorkspace(config, workspaceName) ?? config.workspaces[0];
  const selectedLeftPane = workspacePaneDefault(config, "L", selectedWorkspace?.name);
  const selectedRightPane = workspacePaneDefault(config, "R", selectedWorkspace?.name);
  const initialRolePartition = completeRolePartition(
    rolesFromPaneDefault(selectedLeftPane),
    rolesFromPaneDefault(selectedRightPane),
    Object.keys(config.roles)
  );
  const [leftRoles, setLeftRoles] = useState(initialRolePartition.L);
  const [leftProvider, setLeftProvider] = useState(selectedLeftPane.provider);
  const [rightRoles, setRightRoles] = useState(initialRolePartition.R);
  const [rightProvider, setRightProvider] = useState(selectedRightPane.provider);

  useEffect(() => {
    if (entryKind !== "board" && activeProjectName && workspaceName !== activeProjectName) {
      setWorkspaceName(activeProjectName);
    }
  }, [activeProjectName, entryKind, workspaceName]);

  useEffect(() => {
    const leftPane = workspacePaneDefault(config, "L", workspaceName);
    const rightPane = workspacePaneDefault(config, "R", workspaceName);
    const partition = completeRolePartition(
      rolesFromPaneDefault(leftPane),
      rolesFromPaneDefault(rightPane),
      Object.keys(config.roles)
    );
    setLeftRoles(partition.L);
    setRightRoles(partition.R);
    setLeftProvider(leftPane.provider);
    setRightProvider(rightPane.provider);
  }, [config, workspaceName]);

  useEffect(() => {
    let cancelled = false;

    async function loadRepos() {
      const workspaceRoot = selectedWorkspace?.root;
      if (!workspaceRoot) {
        setRepoOptions([]);
        return;
      }
      setRepoLoading(true);
      try {
        const repos = await unwrap(window.tandem.board.listWorkspaceRepos(workspaceRoot));
        if (cancelled) return;
        setRepoOptions(repos);
        setRepo((current) =>
          current && repos.some((candidate) => candidate.fullName === current)
            ? current
            : repos.length === 1
              ? repos[0].fullName
              : ""
        );
      } catch {
        if (!cancelled) setRepoOptions([]);
      } finally {
        if (!cancelled) setRepoLoading(false);
      }
    }

    void loadRepos();
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace?.root, workspaceName]);

  function changeEntryKind(next: "idea" | "bug" | "board") {
    setEntryKind(next);
    if (next === "bug") setIdeaType("bug");
    if (next === "idea" && ideaType === "bug") setIdeaType("feature");
  }

  function changeIdeaType(next: IdeaType) {
    setIdeaType(next);
    if (next === "bug") setEntryKind("bug");
    else if (entryKind === "bug") setEntryKind("idea");
  }

  useEffect(() => {
    let cancelled = false;

    async function loadBoardArtifacts() {
      if (entryKind !== "board" && !referencePickerOpen) {
        setBoardArtifacts([]);
        setBoardLoading(false);
        return;
      }
      setBoardArtifacts([]);
      setBoardLoading(true);
      setBoardError(null);
      try {
        const artifacts = await unwrap(window.tandem.board.listWorkspaceArtifacts(selectedWorkspace?.name));
        if (!cancelled) setBoardArtifacts(artifacts);
      } catch (error) {
        if (!cancelled) setBoardError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setBoardLoading(false);
      }
    }

    void loadBoardArtifacts();
    return () => {
      cancelled = true;
    };
  }, [entryKind, referencePickerOpen, selectedWorkspace?.name]);

  function referenceBlock(): string {
    if (taskReferences.length === 0) return "";
    return [
      "> Reference tasks:",
      ...taskReferences.flatMap((reference) => [
        `> - ${reference.key} — ${reference.title}`,
        ...(reference.url ? [`>   ${reference.url}`] : [])
      ])
    ].join("\n");
  }

  function withReference(body: string): string {
    const ref = referenceBlock();
    const trimmed = body.trim();
    if (!ref) return trimmed;
    return `${ref}\n\n${trimmed}`.trim();
  }

  // Compose a bug body that mirrors the org's .github/ISSUE_TEMPLATE/bug.yml sections.
  function composeBugBody(): string {
    return [
      ...(referenceBlock() ? [referenceBlock(), ""] : []),
      "### Task owner / author",
      agentDisplayName(config, leftProvider, "L"),
      "",
      "### Summary",
      bugSummary.trim(),
      "",
      "### Environment",
      bugEnvironment,
      "",
      "### Affected service or repo",
      bugService.trim() || repo.trim() || "unknown",
      "",
      "### Steps to reproduce",
      bugSteps.trim(),
      "",
      "### Expected behavior",
      bugExpected.trim(),
      "",
      "### Actual behavior",
      bugActual.trim(),
      "",
      "### Evidence",
      bugEvidence.trim() || "_none provided_",
      "",
      "### Verification plan",
      bugVerification.trim()
    ].join("\n");
  }

  async function submit() {
    setFormError(null);
    if (quickActive) {
      if (!title.trim()) {
        setFormError("Give the quick note a short title.");
        return;
      }
      setSubmitting(true);
      try {
        await doSubmit();
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (entryKind === "bug") {
      const missing = [
        [title, "Title"],
        [bugSummary, "Summary"],
        [bugSteps.replace(/[\d.\s]/g, ""), "Steps to reproduce"],
        [bugExpected, "Expected behavior"],
        [bugActual, "Actual behavior"],
        [bugVerification, "Verification plan"]
      ].find(([value]) => !String(value).trim());
      if (missing) {
        setFormError(`Bug report: "${missing[1]}" is required (matches the GitHub bug template).`);
        return;
      }
    }
    if (entryKind === "board" && !selectedBoardArtifact && !(repo.trim() && issueNumber.trim())) {
      setFormError("Pick an issue from the board first.");
      return;
    }
    setSubmitting(true);
    try {
      await doSubmit();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitToSessionsList() {
    setFormError(null);
    if (entryKind === "board") {
      setFormError("Use this for a new story/bug/architecture, not for attaching an existing board issue.");
      return;
    }
    const cleanTitle = title.trim();
    const description =
      ideaType === "bug"
        ? bugSummary.trim()
        : issueBody.trim();
    if (!cleanTitle) {
      setFormError("Title is required.");
      return;
    }
    if (!description) {
      setFormError("Description is required.");
      return;
    }
    const body = withReference(description);
    setSubmitting(true);
    try {
      await onCreate({
        title: ideaType === "bug" ? `[Bug] ${cleanTitle.replace(/^\[Bug\]\s*/i, "")}` : cleanTitle,
        ideaType,
        attachments: attachments.length > 0 ? attachments : undefined,
        artifactType: "idea",
        workspaceName,
        automationLevel: sessionAutomation,
        issueBody: body,
        leftRole: roleLabel(leftRoles),
        leftProvider,
        rightRole: roleLabel(rightRoles),
        rightProvider,
        dangerouslySkipPermissions,
        localOnly: true
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function doSubmit() {
    if (quickActive) {
      const base = title.trim().replace(/^\[short\]\s*/i, "").replace(/^\[bug\]\s*/i, "");
      await onCreate({
        title: `[Short] ${base}`,
        artifactType: "idea",
        workspaceName,
        automationLevel: sessionAutomation,
        repo: repo.trim() || undefined,
        issueBody: withReference(issueBody),
        quickNote: true,
        quickNoteKind: ideaType === "bug" ? "bug" : "idea",
        ideaType,
        leftRole: roleLabel(leftRoles),
        leftProvider,
        rightRole: roleLabel(rightRoles),
        rightProvider,
        dangerouslySkipPermissions
      });
      return;
    }
    const parsedIssueNumber = Number(issueNumber);
    const attachIssueNumber =
      entryKind === "board" && Number.isFinite(parsedIssueNumber) && parsedIssueNumber > 0 ? parsedIssueNumber : undefined;
    const baseInitialPrompt =
      entryKind === "bug"
        ? composeBugBody()
        : entryKind === "board"
          ? // Board sessions get the status-aware catch-up briefing; anything typed here rides
            // along as an optional user note, so no generic filler prompt.
            issueBody.trim()
          : issueBody.trim() || defaultFirstPrompt(artifactType, repo, attachIssueNumber, title, ideaType);
    const initialPrompt = entryKind === "board" ? baseInitialPrompt : withReference(baseInitialPrompt);
    const sessionTitle = title.trim() || "Untitled Twindem session";
    const sessionIdeaType =
      entryKind === "board"
        ? inferIdeaType({ title: selectedBoardArtifact?.title ?? sessionTitle, labels: selectedBoardArtifact?.labels })
        : ideaType;
    await onCreate({
      title: entryKind === "bug" ? `[Bug] ${sessionTitle.replace(/^\[Bug\]\s*/i, "")}` : sessionTitle,
      ideaType: sessionIdeaType,
      attachments: attachments.length > 0 ? attachments : undefined,
      artifactType,
      workspaceName,
      automationLevel: sessionAutomation,
      repo: selectedBoardArtifact?.repo ?? (repo.trim() || undefined),
      issueNumber: selectedBoardArtifact?.issueNumber ?? attachIssueNumber,
      boardProvider: selectedBoardArtifact?.provider,
      boardItemId: selectedBoardArtifact?.id,
      boardItemKey: selectedBoardArtifact?.key ?? (selectedBoardArtifact ? boardArtifactRef(selectedBoardArtifact) : undefined),
      boardItemUrl: selectedBoardArtifact?.url,
      issueBody: initialPrompt || selectedBoardArtifact?.body,
      leftRole: roleLabel(leftRoles),
      leftProvider,
      rightRole: roleLabel(rightRoles),
      rightProvider,
      dangerouslySkipPermissions
    });
  }

  function updateSessionRoles(side: AgentSide, requestedRoles: string[]) {
    const partition = partitionRolesForSide(side, requestedRoles, leftRoles, rightRoles, Object.keys(config.roles));
    setLeftRoles(partition.L);
    setRightRoles(partition.R);
  }

  function selectBoardArtifact(artifact: BoardArtifactOption) {
    setSelectedBoardArtifact(artifact);
    setRepo(artifact.repo ?? "");
    setIssueNumber(artifact.issueNumber ? String(artifact.issueNumber) : "");
    setTitle((current) => current.trim() || artifact.title);
    setIssueBody((current) => current.trim() || artifact.body || "");
  }

  function toggleReferenceArtifact(artifact: BoardArtifactOption) {
    const key = boardArtifactRef(artifact);
    setTaskReferences((current) =>
      current.some((reference) => reference.key === key)
        ? current.filter((reference) => reference.key !== key)
        : [
            ...current,
            {
              key,
              repo: artifact.repo,
              issueNumber: artifact.issueNumber,
              title: artifact.title,
              url: artifact.url
            }
          ]
    );
  }

  const boardStatuses = ["All", ...Array.from(new Set(boardArtifacts.map((artifact) => artifact.status ?? "No status")))];
  const filteredBoardArtifacts = boardArtifacts.filter((artifact) => {
    const statusOk = selectedBoardStatus === "All" || (artifact.status ?? "No status") === selectedBoardStatus;
    const needle = boardQuery.trim().toLowerCase();
    const queryOk =
      !needle ||
      [artifact.title, artifact.repo ?? "", artifact.key ?? "", String(artifact.issueNumber ?? ""), artifact.status ?? "", ...artifact.labels].some((value) =>
        value.toLowerCase().includes(needle)
      );
    return statusOk && queryOk;
  });

  return (
    <div className="modal-backdrop">
      <section className="new-session">
        <header>
          <div>
            <span className="eyebrow">New session</span>
            <h2>Choose an entry point</h2>
          </div>
          <button onClick={onCancel}>Close</button>
        </header>
        <div className="entry-grid">
          {(
            [
              { key: "idea", label: "Idea" },
              { key: "board", label: "Choose from existing board issues" }
            ] as Array<{ key: "idea" | "board"; label: string }>
          ).map((entry) => (
            <button
              key={entry.key}
              className={entryKind === entry.key ? "active" : ""}
              onClick={() => changeEntryKind(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {quickAllowed && (
          <label className="quick-note-toggle">
            <input type="checkbox" checked={quickNote} onChange={(event) => setQuickNote(event.target.checked)} />
            <span>
              <strong>Quick note</strong> — jot a short note now, flesh it out later. It goes straight on the board
              tagged <code>[Short]</code>; Agent 1 introduces it and asks if you want to discuss.
            </span>
          </label>
        )}
        <section className="session-automation-panel">
          <div>
            <span>Agent loop</span>
            <strong>{sessionAutomation === "auto" ? "Auto" : "Manual"}</strong>
            <small>
              {sessionAutomation === "auto"
                ? "Agent review/fix handoffs run automatically inside a phase."
                : "You trigger Review -> A2 and Findings -> A1 yourself."}
            </small>
          </div>
          <div className="automation-segment modal" role="tablist" aria-label="Agent loop automation">
            {(["auto", "manual"] as const).map((level) => (
              <button
                key={level}
                className={sessionAutomation === level ? "active" : ""}
                onClick={() => setSessionAutomation(level)}
                type="button"
              >
                {level}
              </button>
            ))}
          </div>
        </section>
        {formError && (
          <div className="settings-error">
            <span>{formError}</span>
            <button onClick={() => setFormError(null)}>Dismiss</button>
          </div>
        )}
        {entryKind !== "board" && (
          <section className="idea-type-panel">
            <label>
              Idea type
              <select value={ideaType} onChange={(event) => changeIdeaType(event.target.value as IdeaType)}>
                {IDEA_TYPES.map((type) => (
                  <option key={type.key} value={type.key}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="idea-type-summary">
              <strong>{selectedIdeaType.artifact}</strong>
              <span>{selectedIdeaType.summary}</span>
              <small>
                {selectedIdeaType.requiresImplementation
                  ? "Defaults to implementation work."
                  : "Defaults to a reviewed work product, not code."}
              </small>
            </div>
            <div className="idea-type-phases">
              <span>Planning: {selectedIdeaType.phases.planning}</span>
              <span>In progress: {selectedIdeaType.phases.in_progress}</span>
              <span>Review: {selectedIdeaType.phases.review}</span>
              <span>UAT: {selectedIdeaType.phases.uat}</span>
              <span>Done: {selectedIdeaType.phases.done}</span>
            </div>
          </section>
        )}
        {entryKind !== "board" && (
          <section className="task-reference-panel">
            <div>
              <span>Task references</span>
              {taskReferences.length > 0 ? (
                <strong>
                  {taskReferences.length === 1
                    ? `${taskReferences[0].key} · ${taskReferences[0].title}`
                    : `${taskReferences.length} references selected`}
                </strong>
              ) : (
                <strong>None</strong>
              )}
              {taskReferences.length > 1 && (
                <small>{taskReferences.map((reference) => reference.key).join(", ")}</small>
              )}
            </div>
            <div className="task-reference-actions">
              {taskReferences.length > 0 && <button onClick={() => setTaskReferences([])}>Clear</button>}
              <button onClick={() => setReferencePickerOpen(true)}>Choose from board</button>
            </div>
          </section>
        )}
        {entryKind === "board" && (
          <div className="settings-grid two">
            {config.workspaces.length > 1 ? (
              <label>
                Project
                <select value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)}>
                  {config.workspaces.map((workspace) => (
                    <option key={workspace.name} value={workspace.name}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="context-pill">
                <span>Project</span>
                <strong>{selectedWorkspace?.name ?? "Local project"}</strong>
              </div>
            )}
            <label>
              Repository
              {repoOptions.length > 0 ? (
                <select value={repo} onChange={(event) => setRepo(event.target.value)}>
                  <option value="">{repoLoading ? "Loading repositories..." : "Choose repository"}</option>
                  {repoOptions.map((option) => (
                    <option key={option.path} value={option.fullName}>
                      {option.fullName}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder={repoLoading ? "Loading repositories..." : "owner/repo"}
                />
              )}
            </label>
          </div>
        )}
        <label>
          {ideaType === "bug" ? "Bug title (gets the [Bug] prefix automatically)" : "Title"}
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        {quickActive && (
          <label>
            Quick note (optional)
            <textarea
              value={issueBody}
              onChange={(event) => setIssueBody(event.target.value)}
              rows={3}
              placeholder="A line or two — what's the idea/bug? You can flesh it out later with Agent 1."
            />
          </label>
        )}
        {entryKind !== "board" && ideaType === "bug" && !quickActive && (
          <section className="bug-form">
            {taskReferences.length > 0 && (
              <p className="field-hint linked-parent">
                Linked to <strong>{taskReferences.map((reference) => reference.key).join(", ")}</strong>. The bug body
                will reference them.
              </p>
            )}
            <p className="field-hint">
              Mirrors the GitHub bug template — the same sections land in the issue body when you create the board
              task (with the <code>bug</code> label).
            </p>
            <label>
              Summary — what is broken? *
              <textarea value={bugSummary} onChange={(event) => setBugSummary(event.target.value)} rows={3} />
            </label>
            <div className="settings-grid two">
              <label>
                Environment *
                <select value={bugEnvironment} onChange={(event) => setBugEnvironment(event.target.value as typeof bugEnvironment)}>
                  {(["Local", "UAT", "PROD", "Shared"] as const).map((env) => (
                    <option key={env} value={env}>
                      {env}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Affected service or repo
                <input
                  value={bugService}
                  onChange={(event) => setBugService(event.target.value)}
                  placeholder="backend, mobile app, current workspace, unknown..."
                />
              </label>
            </div>
            <label>
              Steps to reproduce *
              <textarea value={bugSteps} onChange={(event) => setBugSteps(event.target.value)} rows={4} />
            </label>
            <div className="settings-grid two">
              <label>
                Expected behavior *
                <textarea value={bugExpected} onChange={(event) => setBugExpected(event.target.value)} rows={3} />
              </label>
              <label>
                Actual behavior *
                <textarea value={bugActual} onChange={(event) => setBugActual(event.target.value)} rows={3} />
              </label>
            </div>
            <label>
              Evidence (logs, screenshots, URLs, request IDs…)
              <textarea value={bugEvidence} onChange={(event) => setBugEvidence(event.target.value)} rows={2} />
            </label>
            <label>
              Verification plan — how do we prove it&apos;s fixed? *
              <textarea value={bugVerification} onChange={(event) => setBugVerification(event.target.value)} rows={2} />
            </label>
          </section>
        )}
        {entryKind === "board" && (
          <section className="new-session-board-picker">
            <div className="section-title-row">
              <div>
                <h3>Select issue from board</h3>
                <p className="section-note">
                  {boardProviderForWorkspace(config, selectedWorkspace) === "jira"
                    ? `${selectedWorkspace?.jiraProjectKey ?? "Jira"} board`
                    : selectedWorkspace?.githubOwner && selectedWorkspace.projectNumber
                      ? `${selectedWorkspace.githubOwner} project #${selectedWorkspace.projectNumber}`
                      : "Configure a board in Setup or Settings to browse issues."}
                </p>
              </div>
              {boardLoading && <span className="model-chip">Loading</span>}
            </div>
            {boardError && (
              <div className="settings-error">
                <span>{boardError}</span>
                <button onClick={() => setBoardError(null)}>Dismiss</button>
              </div>
            )}
            <input
              value={boardQuery}
              onChange={(event) => setBoardQuery(event.target.value)}
              placeholder="Search board issues..."
            />
            <div className="board-picker-columns">
              <div className="board-status-list">
                {boardStatuses.map((status) => (
                  <button
                    key={status}
                    className={selectedBoardStatus === status ? "active" : ""}
                    onClick={() => setSelectedBoardStatus(status)}
                  >
                    <span>{status}</span>
                    <strong>
                      {status === "All"
                        ? boardArtifacts.length
                        : boardArtifacts.filter((artifact) => (artifact.status ?? "No status") === status).length}
                    </strong>
                  </button>
                ))}
              </div>
              <div className="board-issue-list compact">
                {filteredBoardArtifacts.length > 0 ? (
                  filteredBoardArtifacts.slice(0, 80).map((artifact) => {
                      const selected =
                        selectedBoardArtifact?.id === artifact.id ||
                        Boolean(artifact.repo && artifact.issueNumber && repo === artifact.repo && issueNumber === String(artifact.issueNumber));
                      return (
                        <button
                          key={artifact.id}
                          className={selected ? "board-issue-row selected" : "board-issue-row"}
                          onClick={() => selectBoardArtifact(artifact)}
                        >
                          <span>{artifact.status ?? "No status"}</span>
                          <strong>{artifact.title}</strong>
                          <small>{selected ? `Selected · ${boardArtifactRef(artifact)}` : boardArtifactRef(artifact)}</small>
                        </button>
                      );
                    })
                ) : (
                  <div className="empty-panel">
                    {boardLoading ? "Loading board issues..." : "No board issues match this filter."}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
        {entryKind !== "board" && !quickActive && (
          <div className="attachments-row">
            <div className="attachments-head">
              <span>Attachments (optional) — images, zips with proposed designs, diagrams</span>
              <button onClick={() => void addAttachments()}>Add files…</button>
            </div>
            {attachments.length > 0 && (
              <div className="attachments-list">
                {attachments.map((path) => (
                  <span key={path} className="attachment-chip" title={path}>
                    {path.split("/").pop()}
                    <button
                      aria-label={`Remove ${path}`}
                      onClick={() => setAttachments((current) => current.filter((item) => item !== path))}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <p className="field-hint">
              Copied into the project folder ({`.twindem/attachments/`}) and listed in the brief — the agents open images
              directly and unzip archives to review their contents. Stored locally only, never uploaded.
            </p>
          </div>
        )}
        {quickActive && (
          <p className="field-hint">
            Goes on the board now as <code>[Short]</code> {ideaType !== "feature" ? `(with the ${selectedIdeaType.label.toLowerCase()} label) ` : ""}— Agent 1
            introduces it and asks if you want to discuss.
          </p>
        )}
        {entryKind === "idea" && !quickActive && (
          <p className="field-hint">
            No board task is created yet — discuss the idea with Agent 1, then create the board task later with the “Create task” button.
          </p>
        )}
        {entryKind !== "board" && ideaType === "bug" && !quickActive && (
          <p className="field-hint">
            No board task is created yet — Agent 1 analyzes the bug first; “Create task” puts it on the board with the bug template body.
          </p>
        )}
        {entryKind === "board" && (
          <label>
            Issue number
            <input value={issueNumber} onChange={(event) => setIssueNumber(event.target.value)} />
          </label>
        )}
        {(entryKind === "board" || ideaType !== "bug") && !quickActive && (
          <label>
            {entryKind === "board" ? "Note for Agent 1 (optional)" : "First prompt to Agent 1"}
            <textarea
              value={issueBody}
              onChange={(event) => setIssueBody(event.target.value)}
              placeholder={
                entryKind === "idea"
                  ? "Describe the idea. Agent 1 will analyze it and ask relevant questions..."
                  : "Optional extra context — Agent 1 first reads the issue and summarizes where it stands, then waits for you."
              }
            />
          </label>
        )}
        {referencePickerOpen && (
          <div className="modal-backdrop nested">
            <section className="reference-picker-modal">
              <header>
                <div>
                  <span className="eyebrow">Task references</span>
                  <h2>Choose board tasks</h2>
                </div>
                <button onClick={() => setReferencePickerOpen(false)}>Done</button>
              </header>
              <input
                value={boardQuery}
                onChange={(event) => setBoardQuery(event.target.value)}
                placeholder="Search board issues..."
              />
              <div className="board-picker-columns">
                <div className="board-status-list">
                  {boardStatuses.map((status) => (
                    <button
                      key={status}
                      className={selectedBoardStatus === status ? "active" : ""}
                      onClick={() => setSelectedBoardStatus(status)}
                    >
                      <span>{status}</span>
                      <strong>
                        {status === "All"
                          ? boardArtifacts.length
                          : boardArtifacts.filter((artifact) => (artifact.status ?? "No status") === status).length}
                      </strong>
                    </button>
                  ))}
                </div>
                <div className="board-issue-list compact">
                  {filteredBoardArtifacts.length > 0 ? (
                    filteredBoardArtifacts.slice(0, 80).map((artifact) => {
                      const selected = taskReferences.some((reference) => reference.key === boardArtifactRef(artifact));
                      return (
                        <button
                          key={artifact.id}
                          className={selected ? "board-issue-row selected" : "board-issue-row"}
                          onClick={() => toggleReferenceArtifact(artifact)}
                        >
                          <span>{artifact.status ?? "No status"}</span>
                          <strong>{artifact.title}</strong>
                          <small>{selected ? `Selected · ${boardArtifactRef(artifact)}` : boardArtifactRef(artifact)}</small>
                        </button>
                      );
                    })
                  ) : (
                    <div className="empty-panel">
                      {boardLoading ? "Loading board issues..." : "No board issues match this filter."}
                    </div>
                  )}
                </div>
              </div>
              {taskReferences.length > 0 && (
                <footer>
                  <span>{taskReferences.length} selected</span>
                  <button onClick={() => setTaskReferences([])}>Clear all</button>
                  <button className="primary" onClick={() => setReferencePickerOpen(false)}>Use references</button>
                </footer>
              )}
            </section>
          </div>
        )}
        <div className="settings-grid two">
          <PaneDefaultEditor
            title={agentDisplayName(config, leftProvider, "L")}
            pane={{ role: leftRoles[0], roles: leftRoles, provider: leftProvider }}
            config={config}
            allowEmptyRoles
            onChange={(patch) => {
              if (patch.roles) updateSessionRoles("L", patch.roles);
              else if (patch.role) setLeftRoles([patch.role]);
              if (patch.provider) setLeftProvider(patch.provider);
            }}
          />
          <PaneDefaultEditor
            title={agentDisplayName(config, rightProvider, "R")}
            pane={{ role: rightRoles[0], roles: rightRoles, provider: rightProvider }}
            config={config}
            allowEmptyRoles
            onChange={(patch) => {
              if (patch.roles) updateSessionRoles("R", patch.roles);
              else if (patch.role) setRightRoles([patch.role]);
              if (patch.provider) setRightProvider(patch.provider);
            }}
          />
        </div>
        <section className="session-permissions-panel">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={dangerouslySkipPermissions}
              onChange={(event) => setDangerouslySkipPermissions(event.target.checked)}
            />
            <span>Skip CLI permission prompts for this task (dangerous)</span>
          </label>
          <small>
            Applies only to the session created from this entry point. Leave off when this task should keep normal CLI approvals.
          </small>
        </section>
        <footer>
          <button onClick={onCancel} disabled={submitting}>Cancel</button>
          {entryKind !== "board" && !quickActive && (
            <button onClick={() => void submitToSessionsList()} disabled={submitting}>
              Just put it in sessions list
            </button>
          )}
          <button className="primary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? (quickActive ? "Adding…" : "Creating…") : quickActive ? "Add quick note" : "Create session"}
          </button>
        </footer>
        {submitting && (
          <div className="session-loading-overlay">
            <div className="session-loading-card">
              <TwindemLoader size={52} />
              <strong>
                {entryKind === "board"
                  ? `Loading ${selectedBoardArtifact?.key ?? (repo && issueNumber ? `${repo}#${issueNumber}` : "board task")} from the board…`
                  : "Creating session…"}
              </strong>
              <span>
                {entryKind === "board"
                  ? "Fetching the task, comments and board status. This can take a few seconds."
                  : "Setting up the session."}
              </span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function WorkflowConfirmDialog({
  modal,
  onBodyChange,
  onCancel,
  onConfirm
}: {
  modal: WorkflowModalState;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="workflow-confirm">
        <header>
          <div>
            <span className="eyebrow">GitHub workflow action</span>
            <h2>{modal.title}</h2>
          </div>
          <button onClick={onCancel}>Close</button>
        </header>
        <label>
          Issue comment
          <textarea value={modal.body} onChange={(event) => onBodyChange(event.target.value)} />
        </label>
        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onConfirm} disabled={!modal.body.trim()}>
            {modal.confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

function AttachIssueDialog({
  modal,
  workspace,
  onRefChange,
  onCancel,
  onConfirm,
  onSelect
}: {
  modal: AttachIssueModalState;
  workspace?: TandemConfig["workspaces"][number];
  onRefChange: (ref: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onSelect: (artifact: BoardArtifactOption) => void;
}) {
  const [artifacts, setArtifacts] = useState<BoardArtifactOption[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState("All");
  const canLoadBoard = Boolean(workspace?.githubOwner && workspace.projectNumber);

  useEffect(() => {
    let cancelled = false;
    async function loadArtifacts() {
      if (!workspace?.githubOwner || !workspace.projectNumber) return;
      setLoading(true);
      setLoadError(null);
      try {
        const list = await unwrap(window.tandem.board.listArtifacts(workspace.githubOwner, workspace.projectNumber));
        if (!cancelled) setArtifacts(list);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadArtifacts();
    return () => {
      cancelled = true;
    };
  }, [workspace?.githubOwner, workspace?.projectNumber]);

  const statuses = boardArtifactStatuses(artifacts, workspace);
  const filtered = artifacts.filter((artifact) => {
    const needle = query.trim().toLowerCase();
    const statusMatches = selectedStatus === "All" || (artifact.status ?? "No status") === selectedStatus;
    if (!statusMatches) return false;
    if (!needle) return true;
    return [
      artifact.title,
      artifact.repo ?? "",
      artifact.key ?? "",
      String(artifact.issueNumber ?? ""),
      artifact.status ?? "",
      ...artifact.labels
    ].some((value) => value.toLowerCase().includes(needle));
  });

  async function refreshArtifacts() {
    if (!workspace?.githubOwner || !workspace.projectNumber) return;
    setLoading(true);
    setLoadError(null);
    try {
      setArtifacts(await unwrap(window.tandem.board.listArtifacts(workspace.githubOwner, workspace.projectNumber)));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="workflow-confirm attach-issue-dialog">
        <header>
          <div>
            <span className="eyebrow">GitHub artifact</span>
            <h2>Attach issue</h2>
          </div>
          <button onClick={onCancel}>Close</button>
        </header>
        <div className="board-issue-picker">
          <div className="section-title-row">
            <div>
              <strong>Issues from board</strong>
              <p className="section-note">
                {canLoadBoard
                  ? `${workspace?.githubOwner} project #${workspace?.projectNumber}`
                  : "Configure a GitHub Project in Setup or Settings to browse board issues."}
              </p>
            </div>
            <button
              onClick={() => void (async () => {
                setQuery("");
                setArtifacts([]);
                await refreshArtifacts();
              })()}
              disabled={!canLoadBoard || loading}
            >
              Refresh
            </button>
          </div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, repo, status, label..." />
          {loadError && <div className="settings-error"><span>{loadError}</span></div>}
          <div className="board-picker-columns attach-board-columns">
            <div className="board-status-list">
              {statuses.map((status) => (
                <button
                  key={status}
                  className={selectedStatus === status ? "active" : ""}
                  onClick={() => setSelectedStatus(status)}
                >
                  <span>{status}</span>
                  <strong>{status === "All" ? artifacts.length : artifacts.filter((artifact) => (artifact.status ?? "No status") === status).length}</strong>
                </button>
              ))}
            </div>
            <div className="board-issue-list">
              {loading ? (
                <div className="empty-panel">Loading board issues...</div>
              ) : filtered.length > 0 ? (
                filtered.slice(0, 80).map((artifact) => {
                  const canAttach = Boolean(artifact.repo && artifact.issueNumber);
                  return (
                    <button key={artifact.id} className="board-issue-row" disabled={!canAttach} onClick={() => onSelect(artifact)}>
                      <span>{artifact.status ?? "No status"}</span>
                      <strong>{artifact.title}</strong>
                      <small>{canAttach ? boardArtifactRef(artifact) : `${boardArtifactRef(artifact)} · Project draft item`}</small>
                    </button>
                  );
                })
              ) : (
                <div className="empty-panel">{canLoadBoard ? "No board issues match this board column." : "Board browsing is not configured."}</div>
              )}
            </div>
          </div>
        </div>
        <label>
          Manual issue URL or ref
          <input
            value={modal.ref}
            onChange={(event) => onRefChange(event.target.value)}
            placeholder="https://github.com/owner/repo/issues/26 or owner/repo#26"
          />
        </label>
        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onConfirm} disabled={!modal.ref.trim()}>
            {modal.continueToReview ? "Attach & start review" : "Attach issue"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function IssueEditDialog({
  modal,
  onBodyChange,
  onCancel,
  onConfirm
}: {
  modal: IssueEditModalState;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="workflow-confirm issue-edit-dialog">
        <header>
          <div>
            <span className="eyebrow">{modal.mode === "body" ? "Board artifact" : "Board comment"}</span>
            <h2>{modal.title}</h2>
          </div>
          <button onClick={onCancel}>Close</button>
        </header>
        <label>
          {modal.mode === "body" ? "Issue body" : "Comment"}
          <textarea value={modal.body} onChange={(event) => onBodyChange(event.target.value)} />
        </label>
        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onConfirm} disabled={!modal.body.trim()}>
            {modal.mode === "body" ? "Save body" : "Post comment"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function SessionEditDialog({
  modal,
  onChange,
  onCancel,
  onConfirm
}: {
  modal: SessionEditModalState;
  onChange: (patch: Partial<SessionEditModalState>) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="workflow-confirm session-edit-dialog">
        <header>
          <div>
            <span className="eyebrow">Local session</span>
            <h2>Edit session</h2>
          </div>
          <button onClick={onCancel}>Close</button>
        </header>
        <label>
          Title
          <input value={modal.title} onChange={(event) => onChange({ title: event.target.value })} />
        </label>
        <label>
          Initial idea / issue body
          <textarea value={modal.initialBody} onChange={(event) => onChange({ initialBody: event.target.value })} />
        </label>
        <label>
          Story type
          <select
            value={modal.ideaType}
            onChange={(event) => onChange({ ideaType: event.target.value as IdeaType })}
            disabled={!modal.notStarted}
          >
            {IDEA_TYPES.map((type) => (
              <option key={type.key} value={type.key}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        {modal.notStarted ? (
          <p>
            This not-started task syncs title, body, and story type to the board when Agent 1 starts.
          </p>
        ) : (
          <p>
            Story type is locked after an agent has started this task.
          </p>
        )}
        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onConfirm} disabled={!modal.title.trim()}>
            Save session
          </button>
        </footer>
      </section>
    </div>
  );
}

function DeleteSessionDialog({
  modal,
  busy,
  onChange,
  onCancel,
  onConfirm
}: {
  modal: DeleteSessionModalState;
  busy: boolean;
  onChange: (patch: Partial<DeleteSessionModalState>) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const boardRef = modal.repo && modal.issueNumber
    ? `${modal.repo}#${modal.issueNumber}`
    : modal.boardItemKey ?? modal.boardItemId ?? "remote board task";
  const hasBoardArtifact = Boolean((modal.repo && modal.issueNumber) || modal.boardItemId || modal.boardItemKey);
  return (
    <div className="modal-backdrop">
      <section className="workflow-confirm delete-session-dialog">
        <header>
          <div>
            <span className="eyebrow">Delete session</span>
            <h2>{modal.title}</h2>
          </div>
          <button onClick={onCancel} disabled={busy}>Close</button>
        </header>
        <p>
          This removes the local Twindem session, transcript, cards, evidence and conductor state.
        </p>
        {hasBoardArtifact ? (
          <label className="checkbox-row delete-board-option">
            <input
              type="checkbox"
              checked={modal.deleteBoardArtifact}
              onChange={(event) => onChange({ deleteBoardArtifact: event.target.checked })}
              disabled={busy}
            />
            Also delete/close the remote board task ({boardRef})
          </label>
        ) : (
          <div className="gate-warning">No remote board task is attached to this session.</div>
        )}
        {busy && (
          <div className="create-progress">
            <div className="create-progress-bar"><i /></div>
            <span>
              {modal.deleteBoardArtifact
                ? "Deleting session · deleting/closing remote board task…"
                : "Deleting session…"}
            </span>
          </div>
        )}
        <footer>
          <button onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Deleting…" : "Delete session"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function NativeGateDialog({
  modal,
  config,
  onChange,
  onCancel,
  onConfirm
}: {
  modal: NativeGateModalState;
  config: TandemConfig;
  onChange: (modal: NativeGateModalState) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isImplementer = modal.kind === "choose-implementer";
  const confirmLabel =
    modal.kind === "start-planning"
      ? "Start planning"
      : modal.kind === "choose-implementer"
        ? "Start implementation"
        : modal.kind === "approve-uat"
          ? modal.confirmLabel ?? "Approve UAT"
          : "Record decision";

  return (
    <div className="modal-backdrop">
      <section className="workflow-confirm native-gate">
        <header>
          <div>
            <span className="eyebrow">Human gate</span>
            <h2>{modal.title}</h2>
          </div>
          <button onClick={onCancel}>Close</button>
        </header>
        <p>{modal.body}</p>
        {isImplementer && (
          <div className="settings-grid two">
            <label>
              Implementer
              <select
                value={modal.side}
                onChange={(event) =>
                  onChange({ ...modal, side: event.target.value as AgentSide })
                }
              >
                <option value="L">Agent 1</option>
                <option value="R">Agent 2</option>
              </select>
            </label>
            <label>
              Model
              <select
                value={modal.provider}
                onChange={(event) => onChange({ ...modal, provider: event.target.value })}
              >
                {providerGroups(config, modal.provider).map(([group, entries]) => (
                  <optgroup key={group} label={group}>
                    {entries.map(([key, provider]) => (
                      <option key={key} value={key}>
                        {providerOptionLabel(key, provider)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>
        )}
        {modal.kind === "approve-uat" && modal.mode === "deploy" && (
          <div className="gate-warning">
            Twindem will delegate the UAT deploy to the selected implementer/release agent, record deploy evidence, then move the task to UAT.
          </div>
        )}
        {modal.kind === "approve-uat" && modal.mode === "approval" && (
          <div className="gate-warning">
            Twindem will record the human gate and move the task to UAT for approval. No deploy action will run.
          </div>
        )}
        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

function EvidenceReasonDialog({
  modal,
  onReasonChange,
  onCancel,
  onConfirm
}: {
  modal: EvidenceModalState;
  onReasonChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const title = modal.status === "na" ? "Mark evidence N/A" : "Mark evidence blocked";
  return (
    <div className="modal-backdrop">
      <section className="workflow-confirm evidence-reason">
        <header>
          <div>
            <span className="eyebrow">Evidence reason</span>
            <h2>{title}</h2>
          </div>
          <button onClick={onCancel}>Close</button>
        </header>
        <label>
          Reason
          <textarea
            value={modal.reason}
            onChange={(event) => onReasonChange(event.target.value)}
            placeholder={modal.status === "na" ? "Explain why this evidence does not apply..." : "Explain what is blocking this evidence..."}
          />
        </label>
        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onConfirm} disabled={!modal.reason.trim()}>
            Save evidence
          </button>
        </footer>
      </section>
    </div>
  );
}

export default App;

async function unwrap<T>(promise: Promise<TandemResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

async function reportErrors(operation: () => Promise<void>, onError?: (message: string) => void): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error);
    onError?.(message);
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function panesFromConfig(config: TandemConfig): Record<AgentSide, PaneState> {
  const leftPane = workspacePaneDefault(config, "L");
  const rightPane = workspacePaneDefault(config, "R");
  return {
    L: {
      side: "L",
      roles: rolesFromPaneDefault(leftPane),
      provider: leftPane.provider,
      status: "idle"
    },
    R: {
      side: "R",
      roles: rolesFromPaneDefault(rightPane),
      provider: rightPane.provider,
      status: "idle"
    }
  };
}

function panesFromSession(detail: SessionDetail, config: TandemConfig): Record<AgentSide, PaneState> {
  const leftPane = workspacePaneDefault(config, "L", detail.session.workspaceName);
  const rightPane = workspacePaneDefault(config, "R", detail.session.workspaceName);
  return {
    L: {
      side: "L",
      roles: detail.session.leftRole ? parseRoleLabel(detail.session.leftRole) : rolesFromPaneDefault(leftPane),
      provider: detail.session.leftProvider ?? leftPane.provider,
      status: "idle"
    },
    R: {
      side: "R",
      roles: detail.session.rightRole ? parseRoleLabel(detail.session.rightRole) : rolesFromPaneDefault(rightPane),
      provider: detail.session.rightProvider ?? rightPane.provider,
      status: "idle"
    }
  };
}

function needsOnboarding(config: TandemConfig): boolean {
  return !setupStatus(config).ok;
}

function setupStatus(config: TandemConfig): { ok: boolean; missing: string[] } {
  const workspace = activeWorkspace(config);
  const missing: string[] = [];
  const leftPane = workspacePaneDefault(config, "L", workspace?.name);
  const rightPane = workspacePaneDefault(config, "R", workspace?.name);
  const leftProvider = config.providers[leftPane.provider];
  const rightProvider = config.providers[rightPane.provider];
  const boardType = config.defaults.boardType ?? "github";

  if (config.defaults.setupVersion !== SETUP_VERSION) missing.push("setup review");
  if (!workspace?.root?.trim()) missing.push("local folder");
  if (!leftProvider?.command?.trim() || rolesFromPaneDefault(leftPane).length === 0) missing.push("agent 1");
  if (!rightProvider?.command?.trim() || rolesFromPaneDefault(rightPane).length === 0) missing.push("agent 2");
  if (rolePartitionIssue(rolesFromPaneDefault(leftPane), rolesFromPaneDefault(rightPane), Object.keys(config.roles))) {
    missing.push("role coverage");
  }
  if (boardType === "github" && (!workspace?.githubOwner?.trim() || !workspace.projectNumber)) missing.push("GitHub board");
  if (boardType === "jira") {
    if (!workspace?.jiraSiteUrl?.trim() || !workspace.jiraProjectKey?.trim() || !workspace.jiraEmail?.trim()) {
      missing.push("Jira board");
    }
    if (!workspace?.jiraApiTokenSecretRef?.trim()) missing.push("Jira token");
  }
  if (boardType === "none" || (boardType !== "github" && boardType !== "jira")) missing.push("board");

  return { ok: missing.length === 0, missing };
}

function buildOnboardingConfig(
  config: TandemConfig,
  input: {
    workspaceName: string;
    workspaceRoot: string;
    description: string;
    agentInstructions: string;
    uatReleaseInstructions: string;
    prodReleaseInstructions: string;
    mode: OnboardingMode;
    boardType: BoardType;
    githubOwner: string;
    projectNumber: string;
    issueRepository: string;
    jiraSiteUrl: string;
    jiraProjectKey: string;
    jiraBoardId: string;
    jiraIssueType: string;
    jiraEmail: string;
    jiraApiTokenSecretRef?: string;
    allowedRepoPaths: string[];
    projectLayout: ProjectLayoutEntry[];
    principalRepo?: { owner: string; name: string; path?: string };
    leftCommand: string;
    leftArgs: string;
    leftModel: string;
    leftAuthMode: AgentAuthMode;
    leftDangerouslySkipPermissions: boolean;
    leftSecretRef: string;
    leftRoles: string[];
    rightCommand: string;
    rightArgs: string;
    rightModel: string;
    rightAuthMode: AgentAuthMode;
    rightDangerouslySkipPermissions: boolean;
    rightSecretRef: string;
    rightRoles: string[];
    automationLevel?: AutomationLevel;
    statusMapping?: { write: Record<string, string>; read: Record<string, BoardStatusSlot>; ignored: string[] };
  }
): TandemConfig {
  const templateWorkspace = activeWorkspace(config);
  const workspaceName = input.workspaceName.trim() || "Local project";
  const providerPrefix = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const leftKey = uniqueProviderKey(config, `${providerPrefix}-left-agent`);
  const rightKey = uniqueProviderKey({ ...config, providers: { ...config.providers, [leftKey]: config.providers.codex } }, `${providerPrefix}-right-agent`);
  const leftPane = { ...config.defaults.leftPane, role: input.leftRoles[0], roles: input.leftRoles, provider: leftKey };
  const rightPane = { ...config.defaults.rightPane, role: input.rightRoles[0], roles: input.rightRoles, provider: rightKey };
  const boardProvider: TandemConfig["workspaces"][number]["boardProvider"] =
    input.boardType === "github" ? "github_project" : input.boardType;
  const workspace: TandemConfig["workspaces"][number] = {
    name: workspaceName,
    root: input.workspaceRoot.trim(),
    boardProvider,
    githubOwner: input.boardType === "github" ? input.githubOwner.trim() || undefined : undefined,
    projectNumber: input.boardType === "github" && Number(input.projectNumber) ? Number(input.projectNumber) : undefined,
    issueRepository: input.boardType === "github" ? input.issueRepository.trim() || undefined : undefined,
    jiraSiteUrl: input.boardType === "jira" ? input.jiraSiteUrl.trim() || undefined : undefined,
    jiraProjectKey: input.boardType === "jira" ? input.jiraProjectKey.trim() || undefined : undefined,
    jiraBoardId: input.boardType === "jira" ? input.jiraBoardId.trim() || undefined : undefined,
    jiraIssueType: input.boardType === "jira" ? input.jiraIssueType.trim() || "Task" : undefined,
    jiraEmail: input.boardType === "jira" ? input.jiraEmail.trim() || undefined : undefined,
    jiraApiTokenSecretRef: input.boardType === "jira" ? input.jiraApiTokenSecretRef : undefined,
    allowedRepoPaths: input.allowedRepoPaths.map((item) => item.trim()).filter(Boolean),
    projectLayout: input.projectLayout,
    principalRepo: input.principalRepo,
    uatDeployArgs: templateWorkspace?.uatDeployArgs ?? [],
    workflowTemplate: templateWorkspace?.workflowTemplate ?? "default",
    statusMapping: input.statusMapping ?? templateWorkspace?.statusMapping ?? defaultWorkspaceStatusMapping,
    leftPane,
    rightPane,
    description: input.description.trim() || undefined,
    agentInstructions: input.agentInstructions.trim() || undefined,
    uatReleaseInstructions: input.uatReleaseInstructions.trim() || undefined,
    prodReleaseInstructions: input.prodReleaseInstructions.trim() || undefined
  };

  return {
    ...config,
    workspaces:
      input.mode === "new-project"
        ? [workspace, ...config.workspaces.filter((candidate) => candidate.name !== workspace.name)]
        : [
            workspace,
            ...config.workspaces.filter((candidate) => candidate.name !== workspace.name && candidate.name !== templateWorkspace?.name)
          ],
    providers: {
      ...config.providers,
      [leftKey]: {
        label: providerLabel(input.leftCommand),
        command: input.leftCommand.trim(),
        args: splitArgs(input.leftArgs),
        resumeArgs: [],
        model: input.leftModel.trim() || "default",
        authMode: input.leftAuthMode,
        apiKeyEnv: apiKeyEnvForCommand(input.leftCommand),
        apiKeySecretRef: input.leftAuthMode === "api_key" ? input.leftSecretRef : undefined,
        dangerouslySkipPermissions: input.leftDangerouslySkipPermissions,
        supportsResume: true
      },
      [rightKey]: {
        label: providerLabel(input.rightCommand),
        command: input.rightCommand.trim(),
        args: splitArgs(input.rightArgs),
        resumeArgs: [],
        model: input.rightModel.trim() || "default",
        authMode: input.rightAuthMode,
        apiKeyEnv: apiKeyEnvForCommand(input.rightCommand),
        apiKeySecretRef: input.rightAuthMode === "api_key" ? input.rightSecretRef : undefined,
        dangerouslySkipPermissions: input.rightDangerouslySkipPermissions,
        supportsResume: true
      }
    },
    defaults: {
      ...config.defaults,
      workspaceName: workspace.name,
      setupVersion: SETUP_VERSION,
      boardType: input.boardType,
      automationLevel: input.automationLevel ?? config.defaults.automationLevel,
      leftPane,
      rightPane
    }
  };
}

function providerLabel(command: string): string {
  const normalized = command.trim();
  if (normalized.toLowerCase() === "codex") return "Codex";
  if (normalized.toLowerCase() === "claude") return "Claude Code";
  if (normalized.toLowerCase() === "zsh") return "Shell";
  return normalized || "Agent";
}

function defaultAuthModeForCommand(command: string): AgentAuthMode {
  return providerFamily({ label: providerLabel(command), command }) === "shell"
    ? "none"
    : "subscription";
}

function apiKeyEnvForCommand(command: string): string | undefined {
  const family = providerFamily({ label: providerLabel(command), command });
  if (family === "codex") return "OPENAI_API_KEY";
  if (family === "claude") return "ANTHROPIC_API_KEY";
  return undefined;
}

function agentApiKeySecretRef(workspaceName: string, side: AgentSide): string {
  const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  return `${slug}-${side}-api-key`;
}

function agentProfileApiKeySecretRef(providerKey: string): string {
  const slug = providerKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  return `agent-profile-${slug}-api-key`;
}

function jiraApiTokenSecretRef(workspaceName: string): string {
  const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  return `${slug}-jira-api-token`;
}

function parseJiraBoardUrl(value: string): { siteUrl: string; projectKey?: string; boardId?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { siteUrl: "" };
  try {
    const url = new URL(trimmed);
    const projectMatch = url.pathname.match(/\/projects\/([^/]+)/i);
    const boardMatch = url.pathname.match(/\/boards\/([^/]+)/i);
    return {
      siteUrl: url.origin,
      projectKey: projectMatch?.[1]?.toUpperCase(),
      boardId: boardMatch?.[1]
    };
  } catch {
    return { siteUrl: trimmed };
  }
}

function installCommandForAgent(command: string): string | null {
  const family = providerFamily({ label: providerLabel(command), command });
  if (family === "codex") return "npm install -g @openai/codex";
  if (family === "claude") return "npm install -g @anthropic-ai/claude-code";
  return null;
}

function providerFamily(provider: { command: string; label: string }): string {
  const command = provider.command.toLowerCase();
  const label = provider.label.toLowerCase();
  if (command.includes("codex") || label.includes("codex")) return "codex";
  if (command.includes("claude") || label.includes("claude")) return "claude";
  if (command.includes("zsh") || command.includes("bash") || label.includes("shell")) return "shell";
  return "custom";
}

function providerInitial(provider: TandemConfig["providers"][string]): string {
  const family = providerFamily(provider);
  if (family === "codex") return "C";
  if (family === "claude") return "Cl";
  if (family === "shell") return "$";
  return provider.label.trim().slice(0, 2).toUpperCase() || "AI";
}

function appendUniqueArgs(baseArgs: string[], extraArgs: string[]): string[] {
  const existing = new Set(baseArgs);
  return [...baseArgs, ...extraArgs.filter((arg) => !existing.has(arg))];
}

function permissionBypassArgs(provider: TandemConfig["providers"][string], family: string, sessionOverride?: boolean): string[] {
  const skipPermissions = sessionOverride ?? provider.dangerouslySkipPermissions;
  if (!skipPermissions) return [];
  if (family === "claude") return ["--dangerously-skip-permissions"];
  if (family === "codex") return ["--dangerously-bypass-approvals-and-sandbox"];
  return [];
}

function templateLabel(key: string): string {
  const labels: Record<string, string> = {
    handoffReview: "Handoff review",
    planning: "Technical planning",
    implementation: "Implementation",
    rework: "Changes requested route",
    uatDeploy: "UAT deploy delegation"
  };
  return labels[key] ?? key;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isNoRunningAgentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No running agent process");
}

function latestRunForSide(detail: SessionDetail, side: AgentSide): AgentRunSummary | undefined {
  return detail.runs.find((run) => run.side === side);
}

function canResumeAgent(detail: SessionDetail, side: AgentSide): boolean {
  return Boolean(latestRunForSide(detail, side)?.nativeSessionId);
}

function resolveAgentLaunch(
  provider: TandemConfig["providers"][string] | undefined,
  resume: boolean,
  sessionSkipPermissions?: boolean
): { command: string | undefined; args: string[]; resumeCommand: string | undefined; resumeArgs: string[] } {
  if (!provider) {
    return { command: undefined, args: [], resumeCommand: undefined, resumeArgs: [] };
  }
  const family = providerFamily(provider);
  const baseArgs = appendUniqueArgs(provider.args ?? [], permissionBypassArgs(provider, family, sessionSkipPermissions));
  const resumeCommand = provider.resumeCommand?.trim() || provider.command;
  const resumeArgs = provider.resumeCommand?.trim()
    ? appendUniqueArgs(provider.resumeArgs ?? [], permissionBypassArgs(provider, family, sessionSkipPermissions))
    : defaultResumeArgs(provider, family, sessionSkipPermissions);

  if (resume) {
    return {
      command: resumeCommand,
      args: resumeArgs,
      resumeCommand,
      resumeArgs
    };
  }

  return {
    command: provider.command,
    args: baseArgs,
    resumeCommand,
    resumeArgs
  };
}

function defaultResumeArgs(
  provider: TandemConfig["providers"][string],
  family: string,
  sessionSkipPermissions?: boolean
): string[] {
  const bypassArgs = permissionBypassArgs(provider, family, sessionSkipPermissions);
  const baseArgs = appendUniqueArgs(provider.args ?? [], bypassArgs);
  if (family === "claude") return [...baseArgs, "--continue"];
  if (family === "codex") {
    const userArgs = (provider.args ?? []).filter((arg) => !bypassArgs.includes(arg));
    return [...bypassArgs, "resume", "--last", ...userArgs];
  }
  return provider.resumeArgs?.length ? provider.resumeArgs : baseArgs;
}

function isInvalidResumeOutput(output: string): boolean {
  return /No conversation found with session ID/i.test(output) || /could not find.*conversation/i.test(output);
}

function parseTrustPrompt(buffer: string): boolean {
  const normalized = normalizeTerminalText(buffer.slice(-8000)).slice(-5000).toLowerCase();
  return (
    /(trust|trusted).{0,80}(folder|directory|workspace|repo|repository)/i.test(normalized) ||
    /(folder|directory|workspace|repo|repository).{0,80}(trust|trusted)/i.test(normalized)
  ) && (
    /do you trust|trust this|trusted folder|trusted workspace|untrusted|yes|no|continue/i.test(normalized)
  );
}

function parsePermissionPrompt(side: AgentSide, buffer: string): PermissionPromptModalState | null {
  // Slice the tail FIRST: this runs per pty chunk, and normalizing the whole 40KB buffer before
  // slicing did several full-buffer string passes per chunk. The prompt we look for is recent by
  // definition; 8KB of raw tail comfortably covers the 5KB normalized window.
  const normalized = normalizeTerminalText(buffer.slice(-8000)).slice(-5000);
  if (!normalized.includes("Would you like to run the following command?")) return null;
  if (!normalized.includes("Yes, proceed") && !normalized.includes("Yes, and")) return null;

  const promptStart = normalized.lastIndexOf("Would you like to run the following command?");
  const prompt = normalized.slice(promptStart);
  const reasonMatch = prompt.match(/Reason:\s*([\s\S]*?)(?:ctrl\s*\+\s*a|›?\s*1\.|1\.\s*Yes|$)/i);
  const prefixMatch = prompt.match(/commands?\s+that\s+start\s+with\s+`([^`]+)`/i);
  const commandPreview = compactPermissionPrompt(prompt);

  return {
    side,
    title: "Approve agent command?",
    reason: compactUiText(reasonMatch?.[1]?.trim() || "The agent is asking permission to run a local command.", 220),
    commandPreview,
    rememberPrefix: prefixMatch?.[1]?.trim(),
    detectedAt: new Date().toISOString()
  };
}

function compactPermissionPrompt(prompt: string): string {
  const lines = stripAnsi(prompt)
    .replace(/ctrl\s*\+\s*a\s*view\s*all/gi, "")
    .replace(/›/g, "")
    .replace(/[◦·]/g, "")
    .replace(/\[[^\]]*\d+\s+lines?\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^Would you like to run/i.test(line)) return false;
      if (/^Reason:/i.test(line)) return false;
      if (/^\d+\.\s*(Yes|No)/i.test(line)) return false;
      if (/^Press enter/i.test(line)) return false;
      if (/Action Required/i.test(line)) return false;
      return true;
    })
    .slice(0, 8);
  return lines.join("\n") || "Command details are collapsed in the CLI prompt. Open Debug to inspect the raw terminal output before approving.";
}

function normalizeTerminalText(value: string): string {
  return value
    .split(String.fromCharCode(0))
    .join("")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\r/g, "\n");
}

function normalizeAutomation(level?: string | null): AutomationLevel {
  return level === "auto" ? "auto" : "manual";
}

function automationLabel(level: AutomationLevel): string {
  if (level === "manual") return "Manual review";
  return "Auto review/fix";
}

function automationDescription(level: AutomationLevel): string {
  if (level === "manual") return "You drive everything: trigger Review → A2 and Findings → A1 yourself, and move phases manually.";
  return "The review/fix ping-pong between agents runs automatically within a phase. You still move to the next phase manually.";
}

function agentDisplayName(config: TandemConfig | null, providerKey: string, side: AgentSide): string {
  const provider = config?.providers[providerKey];
  return provider?.label?.trim() || (side === "L" ? "Agent 1" : "Agent 2");
}

function activeWorkspace(config: TandemConfig, workspaceName?: string): TandemConfig["workspaces"][number] | undefined {
  return (
    config.workspaces.find((workspace) => workspace.name === (workspaceName ?? config.defaults.workspaceName)) ??
    config.workspaces[0]
  );
}

function ensureSessionWorkspaces(config: TandemConfig, sessions: SessionSummary[]): TandemConfig {
  const existing = new Set(config.workspaces.map((workspace) => workspace.name));
  const missingNames = Array.from(
    new Set(sessions.map((session) => session.workspaceName?.trim()).filter((name): name is string => Boolean(name)))
  ).filter((name) => !existing.has(name));
  if (missingNames.length === 0) return config;
  const template = config.workspaces[0];
  return {
    ...config,
    workspaces: [
      ...config.workspaces,
      ...missingNames.map((name) => ({
        name,
        root: "",
        allowedRepoPaths: [],
        projectLayout: [],
        uatDeployArgs: [],
        workflowTemplate: template?.workflowTemplate ?? "default",
        statusMapping: template?.statusMapping ?? defaultWorkspaceStatusMapping,
        leftPane: template?.leftPane,
        rightPane: template?.rightPane
      }))
    ]
  };
}

function ensureUsableActiveWorkspace(config: TandemConfig): TandemConfig {
  const current = activeWorkspace(config);
  const boardType = config.defaults.boardType ?? "github";
  const workspaceUsable = (workspace?: TandemConfig["workspaces"][number]) => {
    if (!workspace?.root?.trim()) return false;
    if (boardType === "github") return Boolean(workspace.githubOwner?.trim() && workspace.projectNumber);
    if (boardType === "jira") return Boolean(workspace.jiraSiteUrl?.trim() && workspace.jiraProjectKey?.trim());
    return false;
  };
  if (workspaceUsable(current)) return config;
  const fallback = config.workspaces.find(workspaceUsable);
  if (!fallback || fallback.name === config.defaults.workspaceName) return config;
  return {
    ...config,
    defaults: {
      ...config.defaults,
      workspaceName: fallback.name
    }
  };
}

function workspacePaneDefault(config: TandemConfig, side: AgentSide, workspaceName?: string): TandemConfig["defaults"]["leftPane"] {
  const workspace = activeWorkspace(config, workspaceName);
  const fallback = side === "L" ? config.defaults.leftPane : config.defaults.rightPane;
  return (side === "L" ? workspace?.leftPane : workspace?.rightPane) ?? fallback;
}


function boardStatusForDetail(detail: SessionDetail | null, workspace?: TandemConfig["workspaces"][number]): {
  label: string;
  phase: string;
  index: number;
  slot: BoardStatusSlot | null;
  syncState: "synced" | "stale" | "local";
  syncLabel: string;
} {
  const projectStatus = detail ? boardStatusForSession(detail)?.trim() : undefined;
  const fallbackStatus = statusLabelForVisiblePhase(detail?.session.visiblePhase, workspace);
  const label = projectStatus || fallbackStatus;
  const slot = slotForBoardStatus(label, workspace);
  const options = boardStatusOptions(workspace);
  const index = Math.max(0, options.findIndex((status) => status.slot === slot));
  const matched = options[index] ?? options[0];
  const fetchedAt = detail?.board?.fetchedAt ?? detail?.github?.fetchedAt ?? detail?.session.lastGithubSyncAt;
  const stale = fetchedAt ? Date.now() - new Date(fetchedAt).getTime() > 5 * 60 * 1000 : true;
  return {
    label: projectStatus ? label : slot ? matched.label : label,
    phase: slot ? matched.phase : boardStatusPhaseLabel(null),
    index,
    slot,
    syncState: projectStatus ? (stale ? "stale" : "synced") : "local",
    syncLabel: projectStatus
      ? stale
        ? "Needs sync"
        : `Synced ${formatTime(fetchedAt!)}`
      : "Local fallback"
  };
}

function phaseLabelForVisiblePhase(phase?: string): string {
  const value = phase ?? "capture";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function projectFieldRows(github: GitHubIssueContext): Array<{ name: string; value: string; source: "project" | "fallback" }> {
  const fields = github.projectFields ?? {};
  const labelValue = (prefix: string) => {
    const exact = github.labels.find((label) => label.toLowerCase().startsWith(`${prefix.toLowerCase()}:`));
    if (exact) return exact.split(":").slice(1).join(":").trim();
    return github.labels.find((label) => label.toLowerCase().includes(prefix.toLowerCase()));
  };
  const rows = [
    ["Status", fields.Status ?? github.projectStatus ?? github.state],
    ["Work Type", fields["Work Type"] ?? labelValue("Work Type")],
    ["Area", fields.Area ?? labelValue("Area")],
    ["Priority", fields.Priority ?? labelValue("P")],
    ["Environment", fields.Environment ?? labelValue("Environment")],
    ["Risk", fields.Risk ?? labelValue("Risk")]
  ] satisfies Array<[string, string | undefined]>;
  const baseRows: Array<{ name: string; value: string; source: "project" | "fallback" }> = rows.map(([name, value]) => ({
    name,
    value: value || "Not set",
    source: fields[name] ? "project" : "fallback"
  }));
  const known = new Set(baseRows.map((row) => row.name));
  const extraRows = Object.entries(fields)
    .filter(([name, value]) => !known.has(name) && value)
    .map(([name, value]) => ({ name, value, source: "project" as const }));
  return [...baseRows, ...extraRows];
}

function boardArtifactStatuses(artifacts: BoardArtifactOption[], workspace?: TandemConfig["workspaces"][number]): string[] {
  const present = new Set(artifacts.map((artifact) => artifact.status ?? "No status"));
  const ordered = boardStatusOptions(workspace).map((status) => status.label).filter((status) => present.has(status));
  const extras = Array.from(present)
    .filter((status) => !ordered.includes(status))
    .sort((a, b) => boardColumnSortKeyForStatus(a, workspace) - boardColumnSortKeyForStatus(b, workspace) || a.localeCompare(b));
  return ["All", ...ordered, ...extras];
}

function boardArtifactRef(artifact: BoardArtifactOption): string {
  return artifact.repo && artifact.issueNumber
    ? `${artifact.repo}#${artifact.issueNumber}`
    : artifact.key ?? artifact.id;
}

function boardArtifactRefForSession(session: Pick<SessionSummary, "repo" | "issueNumber" | "boardItemKey" | "boardItemId">): string {
  return session.repo && session.issueNumber
    ? `${session.repo}#${session.issueNumber}`
    : session.boardItemKey ?? session.boardItemId ?? "board item";
}

function boardArtifactUrlForDetail(detail: SessionDetail): string {
  return detail.board?.url ?? detail.github?.url ?? detail.session.boardItemUrl ?? "";
}

function boardBodyForDetail(detail: SessionDetail): string {
  return detail.board?.body?.trim() || detail.github?.body?.trim() || detail.session.initialBody?.trim() || "";
}

function compactPromptBody(body: string, maxLength: number): string {
  if (body.length <= maxLength) return body;
  return `${body.slice(0, maxLength).trim()}\n\n[Truncated by Twindem to keep the two-agent review loop compact. Use the focused findings/evidence above as the working set; ask the human only if this truncation hides a blocking fact.]`;
}

// True only for a materialized GitHub issue (repo + number). GitHub Project DRAFTS and Jira/local
// board items have no issue to read via gh — the work prompts must rely on the task context
// Twindem already injected instead of sending the agent to `gh` (and avoid `undefined#undefined`).
function isGithubIssueSession(detail: SessionDetail): boolean {
  return Boolean(detail.session.repo && detail.session.issueNumber);
}

function isBoardSession(detail: SessionDetail | null | undefined): detail is SessionDetail {
  const session = detail?.session;
  return Boolean(session && ((session.repo && session.issueNumber) || session.boardItemId || session.boardItemKey));
}

function hasBoardArtifactSession(session: Pick<SessionSummary, "repo" | "issueNumber" | "boardItemId" | "boardItemKey"> | null | undefined): boolean {
  return Boolean(session && ((session.repo && session.issueNumber) || session.boardItemId || session.boardItemKey));
}

// Source-of-truth board status: a generic board artifact (Jira/draft) carries its own status;
// fall back to the cached GitHub Project status. For a GitHub issue both are the same value.
function boardStatusForSession(detail: SessionDetail): string | undefined {
  return detail.board?.status ?? detail.github?.projectStatus ?? detail.session.boardStatus;
}

const VISIBLE_PHASE_TO_SLOT: Record<VisiblePhase, BoardStatusSlot> = {
  capture: "inbox",
  define: "planning",
  review: "review",
  execute: "in_progress",
  verify: "uat",
  done: "done"
};

// Phase index (Inbox=0, Planning=1, In Progress=2, UAT=3, Done=4) that works on ANY board. GitHub
// sessions carry a live board status; Jira/local sessions often don't (the board cache has no status
// for them), so fall back to the session's own visiblePhase — which status moves keep in sync. This
// is what lets the auto review loop start in Refinement on Jira, not just GitHub.
function sessionPhaseReached(detail: SessionDetail, workspace?: TandemConfig["workspaces"][number]): number {
  const boardStatus = boardStatusForSession(detail);
  const localPhase = phaseIndexForSlot(VISIBLE_PHASE_TO_SLOT[detail.session.visiblePhase] ?? "inbox");
  if (!boardStatus || !isRealBoardStatus(boardStatus)) return localPhase;
  const realBoardStatus = boardStatus;
  const boardPhase = phaseReachedFromStatus(boardStatus, workspace);
  const duplicateWriteStatus =
    workspace &&
    Object.values(workspace.statusMapping.write).filter((status) => status.trim().toLowerCase() === realBoardStatus.trim().toLowerCase()).length > 1;
  // Jira workflows often map several Twindem slots (in_progress/review/uat) to the same real status.
  // In that case the raw board status cannot tell those slots apart, so keep the explicit local phase
  // Twindem persisted when it moved the task.
  return duplicateWriteStatus ? Math.max(boardPhase, localPhase) : boardPhase;
}

type TaskBadgeKey = "not_started" | "refinement" | "in_progress" | "uat" | "done" | "blocked";

// Status badge for the Tasks list. NOT STARTED is about work/agent history (no agent runs yet), not
// just the board slot — an inbox task that's already been discussed is NOT "not started".
function taskBadge(session: SessionSummary, workspace?: TandemConfig["workspaces"][number]): { key: TaskBadgeKey; label: string } {
  const boardSlot = session.boardStatus ? slotForBoardStatus(session.boardStatus, workspace) : null;
  if (boardSlot === "done" || boardSlot === "wont_do") return { key: "done", label: "DONE" };
  if (!boardSlot && (session.visiblePhase === "done" || session.status === "done")) return { key: "done", label: "DONE" };
  if (session.status === "blocked") return { key: "blocked", label: "BLOCKED" };
  if ((session.agentRunCount ?? 0) === 0) return { key: "not_started", label: "NOT STARTED" };
  if (boardSlot) {
    if (boardSlot === "in_progress" || boardSlot === "review") return { key: "in_progress", label: "IN PROGRESS" };
    if (boardSlot === "uat" || boardSlot === "release_ready") return { key: "uat", label: "IN UAT" };
    return { key: "refinement", label: "IN REFINEMENT" };
  }
  switch (session.visiblePhase) {
    case "execute":
    case "review":
      return { key: "in_progress", label: "IN PROGRESS" };
    case "verify":
      return { key: "uat", label: "IN UAT" };
    default:
      return { key: "refinement", label: "IN REFINEMENT" };
  }
}

// Which list section a task belongs to.
function taskSection(session: SessionSummary, workspace?: TandemConfig["workspaces"][number]): "active" | "not_started" | "done" {
  const key = taskBadge(session, workspace).key;
  if (key === "done") return "done";
  if (key === "not_started") return "not_started";
  return "active";
}

// Strict ownership predicate (zero-cost resume): true only when Twindem itself drove a real board
// transition for this session — so its persisted phase/status IS authoritative and the agent does NOT
// need to re-investigate "where are we" on reopen. A freshly-adopted/external issue Twindem never moved
// has no such event and still gets the assess-and-propose catch-up. NOT satisfied by a status that's
// only a visiblePhase fallback (see jira-status-mapping / zero-cost-session-resume docs).
function isTwindemOwnedKnownSession(detail: SessionDetail): boolean {
  const movedBoard = (detail.workflowEvents ?? []).some((event) => /status\.updated|transition/i.test(event.action));
  const recordedTransition = (detail.evidenceRecords ?? []).some((record) => record.kind === "board_transition");
  return movedBoard || recordedTransition;
}

// Statement-only orientation built from stored state — declares where the task stands so a resumed
// agent doesn't re-derive it. Prepended ONCE to the first real work instruction after a deferred resume.
function resumeOrientationBlock(detail: SessionDetail, workspace?: TandemConfig["workspaces"][number]): string {
  const defs = phaseDefsForIdeaType(detail.session.ideaType);
  const reached = sessionPhaseReached(detail, workspace);
  const status = boardStatusForSession(detail) ?? detail.session.visiblePhase;
  const done = defs
    .slice(0, Math.max(0, Math.min(reached, defs.length)))
    .filter((def) => def.key !== "create")
    .map((def) => def.label);
  const current = defs[Math.min(Math.max(reached, 0), defs.length - 1)]?.label ?? "the current step";
  const lines = [
    "Twindem resume context — this is the authoritative state from the board; do NOT re-investigate it, re-read all comments, or ask where we are:",
    `- Current step: ${current} (board status: ${status}).`,
    done.length ? `- Already completed (do NOT redo): ${done.join(", ")}.` : "- No prior steps completed yet.",
    ...(lastReviewPassedFromEvents(detail.workflowEvents ?? []) ? [`- The in-step review for ${current} has already PASSED.`] : []),
    "Continue from the current step per the instruction that follows.",
    ""
  ];
  return lines.join("\n");
}

// Per-workspace board type for the UI (BoardType), derived from the authoritative resolver so a
// multi-project setup reflects each workspace's own provider — not the global defaults.boardType.
function boardTypeForWorkspace(
  config: TandemConfig | null | undefined,
  workspace?: TandemConfig["workspaces"][number]
): BoardType {
  const provider = boardProviderForWorkspace(config, workspace);
  return provider === "github_project" ? "github" : provider;
}

// Which board a SESSION is bound to (per-session, immutable). Infers GitHub for legacy sessions that
// predate the boardProvider field but carry a repo/issue or a board item (Jira was never attachable,
// so a bare boardItemId is a GitHub Project draft).
function sessionBoardProvider(
  session: Pick<SessionSummary, "boardProvider" | "repo" | "issueNumber" | "boardItemId">
): "github_project" | "jira" | "none" {
  if (session.boardProvider === "jira") return "jira";
  if (session.boardProvider === "github_project") return "github_project";
  if (session.boardProvider === "none") return "none";
  if ((session.repo && session.issueNumber) || session.boardItemId) return "github_project";
  return "none";
}

// Rehydrate the delta-review working set after an app reload / session switch. The most recent
// review evidence record carries A2's structured findings; without this, lastReviewFindingsRef is
// renderer-memory-only and empty on reload, so corrections/re-review fall back to "read everything
// with gh" and the token saving is lost.
function latestStructuredFindings(detail: SessionDetail): ReviewFinding[] {
  for (let i = detail.evidenceRecords.length - 1; i >= 0; i -= 1) {
    const findings = detail.evidenceRecords[i]?.details?.findings;
    if (Array.isArray(findings) && findings.length > 0) return findings as ReviewFinding[];
  }
  return [];
}

function compactMarkdown(value: string, maxLength: number): string {
  return compactUiText(value.replace(/```[\s\S]*?```/g, "[code block]").replace(/[#*_>`-]/g, " "), maxLength);
}

function activeArtifactDisplay(detail: SessionDetail | null, workspace?: TandemConfig["workspaces"][number]): {
  title: string;
  meta: string;
  status?: string;
  url?: string;
} {
  if (!detail) {
    return { title: "No session selected", meta: "Create or select a session" };
  }
  if (detail.board) {
    return {
      title: detail.board.title || detail.session.title,
      meta: detail.board.key,
      status: detail.board.status ?? detail.board.state,
      url: detail.board.url
    };
  }
  if (detail.github) {
    return {
      title: detail.github.title || detail.session.title,
      meta: `${detail.github.repo}#${detail.github.issueNumber}`,
      status: detail.github.projectStatus ?? detail.github.state,
      url: detail.github.url
    };
  }
  if (detail.session.repo && detail.session.issueNumber) {
    return {
      title: detail.session.title,
      meta: `${detail.session.repo}#${detail.session.issueNumber}`,
      status: statusLabelForVisiblePhase(detail.session.visiblePhase, workspace)
    };
  }
  return {
    title: detail.session.title,
    meta: detail.session.artifactType === "idea" ? "Local idea / cross-repo" : "No board task attached",
    status: statusLabelForVisiblePhase(detail.session.visiblePhase, workspace)
  };
}

// How an agent ends its step: by WRITING a signal file that Twindem polls and consumes. Never via
// a printed marker line — the TUI echoes injected prompts and wraps long lines, so printed markers
// re-triggered handoffs from scrollback (the infinite review↔fix loop).
function signalLine(sessionId: string, agent: "A1" | "A2", json: string): string {
  return (
    `write the file \`.twindem/signals/${sessionId}.${agent}.json\` in the project root ` +
    `(create the folders if needed; overwrite the file if it already exists) containing exactly this JSON and nothing else: ${json}`
  );
}

const NO_CHAT_MARKERS =
  "Never print TWINDEM_DONE or TWINDEM_TASK lines in the chat — you signal Twindem ONLY by writing the signal file. (This rule is about those two markers only: TWINDEM_BODY/TWINDEM_REPOS blocks SHOULD still be printed in chat where instructions ask for them.) " +
  "NEVER end a turn that completes your step without writing the signal file — Twindem reacts only to that file; without it the workflow stalls. This applies to EVERY future turn in this conversation, including follow-up discussions with the user: once the step's outcome is ready, write the signal before stopping.";

// Keep the issue-body draft on disk so Twindem can read it reliably (the chat block alone is
// scraped from the TUI and can be missed).
function bodyFileLine(sessionId: string): string {
  return `Also write that same markdown to the file \`.twindem/ideas/${sessionId}.md\` in the project root (create folders if needed; overwrite it each time).`;
}

function projectContextLines(workspace?: TandemConfig["workspaces"][number]): string[] {
  const description = workspace?.description?.trim();
  const instructions = workspace?.agentInstructions?.trim();
  const root = workspace?.root?.trim();
  const layout = (workspace?.projectLayout ?? []).filter((entry) => entry.label.trim() && entry.path.trim());
  const resolveLayoutPath = (p: string): string => {
    const norm = p.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
    if (!root) return norm;
    return `${root.replace(/\/+$/, "")}/${norm}`;
  };
  // Editable code roots (shared, deterministic helper — same list the orientation brief uses).
  const allowedRoots = resolveAllowedRoots(workspace);
  const hasExplicitScope = (workspace?.projectLayout?.length ?? 0) > 0 || Boolean(workspace?.principalRepo) || (workspace?.allowedRepoPaths?.length ?? 0) > 0;
  if (!description && !instructions && !root && layout.length === 0) return [];
  return [
    "",
    "Project context:",
    ...(workspace?.name ? ["Workspace:", workspace.name] : []),
    ...(root
      ? [
          "Workspace root (where you run):",
          root,
          "You are already running inside this workspace root. The board task container may be tracking-only — do NOT treat it as the implementation repo.",
          allowedRoots.length > 0
            ? `Editable code roots (create/edit code ONLY inside these): ${allowedRoots.join(", ")}`
            : "Editable scope: this local workspace root.",
          hasExplicitScope
            ? "If a change doesn't clearly belong to a listed component, put it in the principal repo at the project root and SAY SO in your plan. Never create code outside the editable roots above."
            : "Do NOT edit or open PRs in sibling/external repositories outside this workspace root unless the user explicitly authorizes it."
        ]
      : []),
    ...(layout.length > 0
      ? [
          "Project layout — where each part lives (absolute paths inside the project folder; create the folder if missing, then put that part's code there):",
          ...layout.map((entry) => {
            const repo = entry.repo ? ` [repo: ${entry.repo.owner}/${entry.repo.name}]` : "";
            return `- ${entry.label.trim()} → ${resolveLayoutPath(entry.path)}${repo}`;
          })
        ]
      : []),
    ...(workspace?.principalRepo
      ? [`Principal/root code repo: ${workspace.principalRepo.owner}/${workspace.principalRepo.name} (catch-all for code that fits no component).`]
      : []),
    ...(description ? ["Description:", description] : []),
    ...(instructions ? ["Standing agent instructions:", instructions] : [])
  ];
}

function ideaTypeLines(detail: SessionDetail): string[] {
  const type = ideaTypeDefinition(detail.session.ideaType);
  return [
    "",
    "Idea type / workflow template:",
    `- Type: ${type.label}`,
    `- Expected artifact: ${type.artifact}`,
    `- Requires implementation by default: ${type.requiresImplementation ? "yes" : "no"}`,
    `- Planning means: ${type.phases.planning}`,
    `- In progress means: ${type.phases.in_progress}`,
    `- Review means: ${type.phases.review}`,
    `- UAT means: ${type.phases.uat}`,
    `- Done means: ${type.phases.done}`,
    `- Evidence expected before done: ${type.evidence}`,
    ...qualityRuleLines(detail.session.ideaType)
  ];
}

function initialAnalysisBriefing(detail: SessionDetail, workspace?: TandemConfig["workspaces"][number]): string | null {
  const body = detail.session.initialBody?.trim();
  if (!body) return null;
  const type = ideaTypeDefinition(detail.session.ideaType);
  const artifactRef = detail.session.repo && detail.session.issueNumber
    ? `${detail.session.repo}#${detail.session.issueNumber}`
    : detail.session.title;
  // A linked bug carries "Related to <repo>#N" — make the agent read that task for context.
  const relatedMatch = body.match(/Related to\s+([\w.-]+\/[\w.-]+)#(\d+)/i);
  const relatedLine = relatedMatch
    ? `This is RELATED to ${relatedMatch[1]}#${relatedMatch[2]} — FIRST use gh to read that task (its body, ALL comments, and any linked PRs/branches) so you understand the original work and what likely regressed, then analyze this bug in that context.`
    : null;
  return [
    "Twindem initial brief.",
    "",
    `Artifact: ${artifactRef}`,
    ...projectContextLines(workspace),
    ...ideaTypeLines(detail),
    "",
    "User idea / issue body:",
    body,
    "",
    ...(relatedLine ? [relatedLine, ""] : []),
    "If the brief above lists LOCAL ATTACHMENTS (.twindem/attachments/...), inspect them FIRST: open image files directly (you can view them), unzip archives into a temp folder and review their contents (e.g. proposed designs), and factor everything into your analysis.",
    `Please start by analyzing this ${type.label.toLowerCase()} idea, not by implementing it.`,
    type.requiresImplementation
      ? "Ask clarification questions and shape the product/technical analysis: scope, data model/approach, affected areas inside the workspace root, risks/edge cases, acceptance criteria, and a test plan."
      : "Ask clarification questions and shape the non-implementation work product: options, constraints, tradeoffs, affected areas, risks, validation approach, and what evidence is needed for human approval.",
    "Do NOT create or modify any board task, comment, or label — the human creates the board task from Twindem. Read only local workspace files unless the brief explicitly references an external board item you can access.",
    "When the idea is shaped enough to become a board task, do BOTH of these so Twindem captures the description reliably:",
    `  1) Write the FULL task description as markdown to the file \`.twindem/ideas/${detail.session.id}.md\` in the project root (create the \`.twindem/ideas\` folders if needed).`,
    "  2) Also print that same markdown between a line `TWINDEM_BODY:` then `<<<` and a closing `>>>`.",
    type.requiresImplementation
      ? "The markdown must contain these sections with real content (not placeholders): Problem, Scope / approach, Affected areas inside the workspace root, Acceptance criteria, Test plan, Open questions."
      : "The markdown must contain these sections with real content (not placeholders): Decision/problem statement, Options considered, Recommended approach, Tradeoffs & risks, Validation / evidence plan, Open questions.",
    `Then, to ask Twindem to create the board task, ${signalLine(detail.session.id, "A1", '{"phase":"task"}')}`,
    "After writing that signal file, STOP and WAIT. The board task does NOT exist until Twindem confirms the created board reference back to you. Do not continue as if the task exists before that confirmation.",
    `IMPORTANT: if you have OPEN QUESTIONS, do NOT hand off to a reviewer yet — discuss and resolve them with the user first. Only AFTER the open questions are resolved with the user, signal that the idea is ready for review: ${signalLine(detail.session.id, "A1", '{"phase":"ready"}')}`,
    NO_CHAT_MARKERS,
    type.requiresImplementation ? "Do not start coding." : "Do not start coding unless the user explicitly asks for a proof of concept or spike."
  ].join("\n");
}

function quickNoteIntroInstruction(detail: SessionDetail, note: string): string {
  const ref = boardArtifactRefForSession(detail.session);
  const type = ideaTypeDefinition(detail.session.ideaType);
  const url = boardArtifactUrlForDetail(detail);
  return [
    `Twindem — a quick ${type.label} note was just captured and placed on the board as ${ref} with the [Short] tag (a rough draft, NOT fully specified yet).`,
    ...(url ? [`URL: ${url}`] : []),
    ...ideaTypeLines(detail),
    note ? `The user's note:\n${note}` : "The note is essentially empty — the user will explain.",
    "Give a ONE-LINE summary of what this seems to be about.",
    "Then ASK the user whether they want to start discussing / fleshing it out now — and WAIT for their answer. Do NOT analyze deeply, plan, or write code yet.",
    "Do NOT run any gh write commands or change the issue."
  ].join("\n");
}

function catchUpInstruction(detail: SessionDetail, workspace?: TandemConfig["workspaces"][number]): string {
  const ref = boardArtifactRefForSession(detail.session);
  const artifactUrl = detail.board?.url ?? detail.github?.url ?? detail.session.boardItemUrl ?? "";
  const artifactTitle = detail.board?.title || detail.github?.title || detail.session.title;
  const provider = detail.board?.provider ?? detail.session.boardProvider ?? "github_project";
  const body = detail.board?.body?.trim() || detail.github?.body?.trim() || detail.session.initialBody?.trim();
  const isShort = /\[short\]/i.test(detail.github?.title ?? detail.session.title);
  const boardStatus = detail.board?.status ?? detail.github?.projectStatus;
  const hasStatus = isRealBoardStatus(boardStatus);
  const status = hasStatus ? boardStatus! : boardStatusForSlot("inbox", workspace);
  const phase = phaseReachedFromStatus(status, workspace);
  const type = ideaTypeDefinition(detail.session.ideaType);
  // What Agent 1 is ALLOWED to do in this exact status — never jump ahead.
  let scope: string;
  if (isShort) {
    // Quick-captured [Short] draft: same light intro as when it was first added — summarize and
    // offer to discuss, don't deep-dive.
    scope =
      "This is a [Short] quick-note draft — NOT fully specified. Give a one-line summary of what it is, then ASK the user whether they want to start discussing / fleshing it out now, and WAIT. Do NOT analyze deeply, plan, or write code.";
  } else if (phase <= 0) {
    scope =
      "The task is in INBOX (idea only). Just summarize what the task is and confirm it's ready for Refinement. " +
      "Do NOT analyze deeply, do NOT plan implementation, do NOT write or run any code. Wait for the human to start Refinement.";
  } else if (phase === 1) {
    scope =
      `The task is in REFINEMENT / PLANNING. For this ${type.label}, summarize the current ${type.artifact} plan/body and the state of review (comments). ` +
      "Do NOT implement or write/run code. Only refine the work product if explicitly asked.";
  } else if (phase === 2) {
    scope =
      type.requiresImplementation
        ? "The task is IN PROGRESS (implementation). Summarize what's already implemented and what remains, then you MAY continue the implementation per the plan in the issue body."
        : `The task is IN PROGRESS for a non-implementation workflow. Summarize the ${type.artifact} being created, evidence gathered, and what remains. Do NOT write production code unless the issue explicitly calls for a proof of concept or spike.`;
  } else if (phase === 3) {
    scope = "The task is in UAT (testing). Summarize the testing status. Do NOT change code unless explicitly asked.";
  } else {
    scope = "The task is DONE. Summarize the outcome. No further changes.";
  }
  // This catch-up turn is READ-ONLY: A1 only reports state. The signal protocol applies to LATER
  // turns when the user asks for NEW work — never to this catch-up. (A1 was re-signalling "ready"
  // on reopen of an already-implemented + reviewed task, re-triggering a review that already passed.)
  const signalProtocol =
    phase <= 2
      ? [
          "THIS TURN IS A READ-ONLY CATCH-UP: do NOT write any signal file now, no matter what you find. Reading, verifying, or summarising existing work is NOT 'completing work' and never gets a signal.",
          `Only on a LATER turn, when the user asks you to PRODUCE or CHANGE something new and you finish it, ${signalLine(detail.session.id, "A1", '{"phase":"ready"}')}`,
          "If the work for the current phase has ALREADY been reviewed and approved (a reviewer 'Verdict: OK' comment exists and nothing changed since), say so plainly — it is DONE, do NOT signal, and tell the human the next step is to advance the phase. Do NOT re-do or re-submit completed work.",
          NO_CHAT_MARKERS
        ]
      : [];
  // No board status: the status reflects PROGRESS (labels carry the type, e.g. "bug"), so A1
  // assesses where the issue actually stands and proposes the status right after its summary.
  if (!hasStatus) {
    scope =
      "This issue has NO board status yet — do NOT assume a phase. Read everything, summarize where it stands, propose the status (below), and then WAIT for the human. Do not start planning or coding.";
  }
  const statusProposal = hasStatus
    ? []
    : [
        "This issue has NO status on the Project board yet. Right after your summary, assess its ACTUAL progress from the body, comments, and any linked branches/PRs, and propose the correct status:",
        `- fresh idea or freshly reported bug, nothing agreed yet -> ${boardStatusForSlot("inbox", workspace)}`,
        `- a technical plan exists / is being refined or reviewed -> ${boardStatusForSlot("planning", workspace)}`,
        `- implementation has visibly started (branch, PR, commits) -> ${boardStatusForSlot("in_progress", workspace)}`,
        `- deployed and being tested -> ${boardStatusForSlot("uat", workspace)}`,
        `Then ${signalLine(detail.session.id, "A1", `{"phase":"status","status":"${boardStatusForSlot("inbox", workspace)}"}`)} — replacing ${boardStatusForSlot("inbox", workspace)} with the status you assessed (${PROPOSABLE_STATUS_SLOTS.map((slot) => boardStatusForSlot(slot, workspace)).join(", ")}).`
      ];
  return [
    `Twindem — resuming board task ${ref}.`,
    `Task title: ${artifactTitle}`,
    `URL: ${artifactUrl}`,
    ...projectContextLines(workspace),
    ...ideaTypeLines(detail),
    ...(body ? ["Task body / description:", body] : []),
    hasStatus
      ? `Current board status: ${status}. This status IS the exact point in the workflow — stay strictly within it.`
      : "Current board status: none yet (the card is not on the board's main track).",
    provider === "jira"
      ? "You are Agent 1. This task came from Jira. Use the task title/status/URL and task body provided by Twindem as the source of truth for now. Do NOT use gh for this task. If Jira comments are needed but not present in this brief, ask the human for the missing context and WAIT."
      : body
        ? "You are Agent 1. The task body above is Twindem's synced copy of the issue — do NOT re-read the body with gh. Use gh ONLY to read the comments (they show where the task stands)."
        : "You are Agent 1. First use gh to read the issue body, labels, status, and ALL comments.",
    scope,
    ...statusProposal,
    ...signalProtocol,
    "In your summary, state CLEARLY which workflow steps are already DONE (idea shaped / plan reviewed & approved / implemented / code reviewed & approved / deployed), based on the comments and verdicts — so nothing already finished gets repeated.",
    "Do NOT jump ahead to a later phase. Finish with a short summary of where we are and what the next step is."
  ].join("\n");
}

// A1 (Author/Implementer): produce the technical plan. NEVER gives a verdict.
// Discipline shared by author + reviewer so the A1↔A2 loop stays efficient and converges:
// proportionality, resolve-don't-hedge, and a hard ban on board/process bikeshedding (which made
// a button-style change spiral into a 7-round audit over repos/labels/project membership).
const PROPORTIONALITY_LINE =
  "PROPORTIONALITY: match your effort to the size of the change. A one-file style/CSS tweak gets a few lines; a big feature gets a fuller treatment. Never inflate a trivial change into a multi-section document or a multi-round audit.";

const NO_PROCESS_LINE =
  "STAY OUT OF BOARD/PROCESS BOOKKEEPING — Twindem and the human handle it. Do NOT create/move/link board tasks, set labels, add items to a board, manage milestones/assignees, or worry about which board container the task lives in. None of that belongs in this plan or review.";

function analysisInstruction(detail: SessionDetail, round: number, workspace?: TandemConfig["workspaces"][number]): string {
  const ref = boardArtifactRefForSession(detail.session);
  const type = ideaTypeDefinition(detail.session.ideaType);
  const planTitle = type.requiresImplementation ? "Technical plan" : `${type.label} work product plan`;
  const url = boardArtifactUrlForDetail(detail);
  const body = boardBodyForDetail(detail);
  const provider = detail.board?.provider ?? detail.session.boardProvider ?? "github_project";
  return [
    `Twindem — Refinement / Planning for board task ${ref} (round ${round}).`,
    ...(url ? [`URL: ${url}`] : []),
    ...projectContextLines(workspace),
    ...ideaTypeLines(detail),
    ...(body ? ["Current task body / description (source of truth):", compactPromptBody(body, 6000)] : []),
    provider === "jira"
      ? "This is a Jira task. You cannot read Jira directly from the CLI. Use the task body above; if it is insufficient, ask the human for missing Jira context and WAIT."
      : body
        ? "Use the task body above as the source of truth. Do not re-read or rewrite board metadata."
        : "If the task body is missing, ask the human for the missing scope before planning.",
    `You are Agent 1 (Author). Produce the ${type.requiresImplementation ? "technical plan" : `${type.artifact} plan`} for EXACTLY this task — nothing more.`,
    PROPORTIONALITY_LINE,
    "RESOLVE unknowns instead of hedging: if unsure of a field name, file, or existing pattern, READ the code (gh/grep) and DECIDE. The plan must state concrete decisions — never 'likely X' or 'if Y then Z'.",
    type.requiresImplementation
      ? "Cover only what's needed: the concrete change, the exact files/areas, data/contract if relevant, precise acceptance criteria, and a test plan. Skip sections that don't apply to this change."
      : "Cover only what's needed: the decision/research/procedure scope, constraints, options, tradeoffs, validation evidence, risks, and the exact artifact to produce. Do not force code acceptance criteria where they do not apply.",
    NO_PROCESS_LINE,
    type.requiresImplementation
      ? "Reading code with local file tools is fine; make NO board write changes, and do NOT start coding."
      : "Reading code, docs, and infrastructure files with local file tools is fine; make NO board write changes, and do NOT start coding unless the task explicitly calls for a proof of concept or spike.",
    "Output the COMPLETE plan as the issue body. It REPLACES the body entirely — there is only ever ONE authoritative plan, never an old version plus a new one:",
    "TWINDEM_BODY:",
    "<<<",
    `## ${planTitle}`,
    type.requiresImplementation
      ? "(the full, self-contained plan — exactly what to develop)"
      : `(the full, self-contained plan — exactly what ${type.artifact} to produce and how it will be validated)`,
    ">>>",
    "Also list impacted workspace paths/repos on one line, using ONLY repos/directories inside the workspace root, e.g.: TWINDEM_REPOS: current-workspace",
    bodyFileLine(detail.session.id),
    `When the plan is ready for review, ${signalLine(detail.session.id, "A1", '{"phase":"ready"}')}`,
    NO_CHAT_MARKERS
  ].join("\n");
}

// Attribution footer required on every agent-authored comment (user requirement: every task and
// comment ends with created/updated by <AI name + version>).
function signCommentsLine(signature?: string): string {
  return `Sign EVERY comment you post on the issue with this exact final line: _updated by ${signature ?? "the agent"} via Twindem_`;
}

function boardCommentProtocolLines(
  detail: SessionDetail,
  action: string,
  signature?: string
): string[] {
  if (isGithubIssueSession(detail)) {
    return [action, signCommentsLine(signature)];
  }
  return [
    action.replace(/^Post /, "Prepare ").replace(/^Record /, "Prepare a board comment recording "),
    "This is not a GitHub issue. Do NOT use Jira, a browser, or a Jira CLI to post comments. Include the complete board comment body in your final Twindem signal as a JSON string field named \"comment\"; Twindem will post it through the configured Board service layer.",
    `Do not add the attribution footer yourself; Twindem will append: _updated by ${signature ?? "the agent"} via Twindem_`
  ];
}

function releaseDeliveryContextLines(workspace?: TandemConfig["workspaces"][number]): string[] {
  const root = workspace?.root?.trim();
  const deliveryRepos = (workspace?.projectLayout ?? []).filter(
    (entry) => entry.label.trim() && entry.path.trim() && entry.repo?.owner?.trim() && entry.repo?.name?.trim()
  );
  if (!root && deliveryRepos.length === 0 && !workspace?.principalRepo) return [];
  const rootPrefix = root?.replace(/\/+$/, "");
  const pathFor = (path?: string): string => {
    const norm = (path ?? "").trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
    if (!rootPrefix) return norm || ".";
    return norm ? `${rootPrefix}/${norm}` : rootPrefix;
  };
  const lines = ["", "Workspace delivery map:"];
  if (rootPrefix) lines.push(`- Workspace root: ${rootPrefix}`);
  if (workspace?.principalRepo) {
    lines.push(`- Principal/root repo: ${pathFor(workspace.principalRepo.path)} -> ${workspace.principalRepo.owner}/${workspace.principalRepo.name}`);
  }
  lines.push(
    ...deliveryRepos.map((entry) => `- ${entry.label.trim()}: ${pathFor(entry.path)} -> ${entry.repo!.owner}/${entry.repo!.name}`)
  );
  if (deliveryRepos.length > 0 || workspace?.principalRepo) {
    lines.push(
      "Delivery rule for mapped component repos: the local component path is the SOURCE tree, but the GitHub repo on the right is the DELIVERY repo. If the source path is not already a checkout of that exact GitHub repo, do NOT add that repo as a remote and push the source branch directly.",
      "A configured `origin` alone is not enough to treat the source path as the delivery repo. First verify the source branch has common history with the delivery repo's main/default branch; if it does not, use the separate delivery-repo checkout flow.",
      "Instead, create or reuse a separate checkout/worktree of the delivery repo, branch from its main/default branch, copy the source component contents into that checkout, commit there, push that branch, and open the PR from that delivery repo history.",
      "Use committed task-specific source changes as the delivery delta. Do NOT use `git status --short` or arbitrary dirty/untracked files as the file list; dirty files may belong to another task. Identify commits for the current board task/ref, restrict them to the mapped source component path, then copy those paths into the delivery checkout with the component prefix stripped.",
      "Before committing in the delivery checkout, verify the diff is non-empty and task-relevant. If the diff is empty or only touches files unrelated to the current board task, STOP and report the mismatch instead of opening a PR.",
      "A GitHub error like 'branch has no history in common with main' means you pushed from the source component history by mistake. Correct it by using the separate delivery-repo checkout flow above; that is the required delivery path, not an alternative workaround."
    );
  }
  return lines;
}

// A board comment summarizing an A2 verdict + findings — posted by Twindem on boards the agents can't
// write to (Jira). Keeps the review trail visible on the board, same as gh comments do on GitHub.
function reviewVerdictComment(round: number, verdict: string | undefined, findings?: ReviewFinding[]): string {
  const head =
    verdict === "OK"
      ? `✅ Review passed (round ${round}) — approved, ready to advance.`
      : verdict === "Changes requested"
        ? `🔧 Agent 2 review (round ${round}) — changes requested.`
        : verdict === "Blocked"
          ? `⛔ Agent 2 review (round ${round}) — blocked.`
          : `Agent 2 review (round ${round}).`;
  const lines = [head];
  if (findings && findings.length > 0) {
    lines.push("", "Findings:", ...findings.map(findingLine));
  }
  lines.push("", "_posted by Agent 2 review via Twindem_");
  return lines.join("\n");
}

// Render an open/addressed finding for inlining into an instruction (delta review protocol).
function findingLine(finding: ReviewFinding): string {
  const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
  return `- ${finding.id} [${finding.severity === "blocking" ? "BLOCKING" : "non-blocking"}]${location} ${finding.title}: ${finding.detail}`;
}

// A2 (Reviewer): review the current state + ALL comments. Gives exactly one verdict. NEVER fixes.
// Round N+1 with structured findings is DELTA-SCOPED: verify only the addressed findings instead
// of re-paying the full review context.
function reviewInstruction(
  detail: SessionDetail,
  round: number,
  signature?: string,
  workspace?: TandemConfig["workspaces"][number],
  previousFindings?: ReviewFinding[]
): string {
  const ref = boardArtifactRefForSession(detail.session);
  const status = boardStatusForSession(detail) ?? detail.session.visiblePhase;
  const reachedImplement = sessionPhaseReached(detail, workspace) >= 2;
  // Twindem already holds the synced body/plan — inject it so A2 doesn't re-fetch context we have.
  const rawBody = boardBodyForDetail(detail);
  const body = compactPromptBody(rawBody, round > 1 ? 4500 : 9000);
  const isGithubIssue = isGithubIssueSession(detail);
  const url = boardArtifactUrlForDetail(detail);
  // One source of truth for "where the body is" — reused in both the subject and the A2 line so a
  // missing sync never produces "the body is above" while the body isn't actually in the prompt.
  const bodyContextLine = body
    ? "The task body/plan is provided above (synced by Twindem) — do NOT re-read the issue body with gh."
    : isGithubIssue
      ? "Twindem has no synced task body — use gh ONCE to read the issue body and relevant comments, then stop fetching."
      : "Twindem has no synced task body for this non-GitHub board item — do NOT use gh. Review the title, board URL, evidence, and prior context provided here; if more Jira context is needed, ask the human and WAIT.";
  const type = ideaTypeDefinition(detail.session.ideaType);
  // Planning → review the PLAN (no code/PR exists yet). Implement/Review → review the actual code.
  const subject = reachedImplement
    ? type.requiresImplementation
      ? [
        `You are reviewing the IMPLEMENTATION. ${bodyContextLine} Use gh for the linked PR/branch and the diff. Check correctness, that it matches the plan, scope creep, and tests.`,
        "Findings must be BLOCKING technical problems in the CODE only (bugs, missing tests for the change, wrong behavior, out-of-scope edits). If it works and matches the plan, return OK."
      ]
      : [
          `You are reviewing the ${type.artifact.toUpperCase()} created for this ${type.label} workflow. ${bodyContextLine} Inspect any referenced docs, diagrams, runbooks, or optional spike output.${isGithubIssue ? " Use gh only for material not already shown." : " Do not use gh for this non-GitHub board item."}`,
          type.key === "spike"
            ? "Findings must be BLOCKING problems in the spike output only: missing experiment question/scope, missing prototype or feasibility evidence, unsupported recommendation, missing risks/follow-up tasks, or missing ADR conclusion update back to the source ADR."
            : "Findings must be BLOCKING problems in the work product only: unsupported recommendation, missing critical risk, unsafe procedure, unclear validation, wrong assumption, or evidence gap. Do not require code unless the issue explicitly requested a spike."
        ]
    : [
        `You are reviewing the PLAN (Planning phase) for a ${type.label} workflow. There is NO code, branch, or PR yet — that is correct; do NOT look for, mention, or require them.`,
        type.requiresImplementation
          ? "Review ONLY the plan itself: is the approach correct, complete, and implementable for THIS exact task? Findings must be BLOCKING technical problems only — a wrong/contradictory approach, a missing step that breaks the change, an incorrect field/contract, or a missing acceptance/test point that actually matters. If the plan would work as written, return OK."
          : `Review ONLY the ${type.artifact} plan itself: is the scope, evidence plan, options/tradeoffs, validation approach, and approval path sufficient for THIS exact task? Do NOT require the final ${type.artifact} to already exist in Planning/Refinement — creating the artifact happens in the next In Progress step. Findings must be BLOCKING work-product-plan problems only. If the plan would produce a defensible artifact, return OK.`
      ];
  return [
    `Twindem — review round ${round} for board task ${ref} (board status: ${status}).`,
    ...(url ? [`URL: ${url}`] : []),
    ...projectContextLines(workspace),
    ...ideaTypeLines(detail),
    ...(body ? [`Task body / plan (synced by Twindem, compacted to ${body.length.toLocaleString()} chars — do NOT re-fetch it with gh):`, body] : []),
    isGithubIssue
      ? `You are Agent 2 (Reviewer). ${bodyContextLine} Use gh only for the linked PR/diff (when reviewing code) or a specific comment not already shown.`
      : "You are Agent 2 (Reviewer). Review the task body/plan and prior findings from the task context Twindem provided above — do NOT use gh for this task (it is not a GitHub board task). Twindem will post your verdict/findings to the remote board as a comment after you write the signal file.",
    ...subject,
    PROPORTIONALITY_LINE,
    NO_PROCESS_LINE,
    "NEVER block or comment on: board placement, labels, board membership, cross-links between tasks, milestones, assignees, or 'no PR/branch yet'. Ignore all of that — it is not part of a technical review.",
    round > 1
      ? previousFindings && previousFindings.length > 0
        ? [
            "FOLLOW-UP ROUND (delta review): Agent 1 addressed your previous findings, listed below by id. Verify ONLY these findings — do NOT re-review the rest of the plan/code, and do NOT introduce NEW findings you could have raised earlier (no moving goalposts):",
            ...previousFindings.map(findingLine),
            "If every blocking finding above is resolved, return OK even if you can now imagine further nice-to-haves."
          ].join("\n")
        : "FOLLOW-UP ROUND: check ONLY whether your PREVIOUS findings were fixed. Do NOT introduce NEW findings you could have raised earlier — no moving goalposts. If your previous findings are addressed, return OK even if you can now imagine further nice-to-haves."
      : "FIRST REVIEW: raise ALL real blocking issues now, in one pass, so the author can fix them together. Don't drip-feed findings across rounds.",
    "The current task body/context is the single authoritative plan — review the CURRENT body/context; ignore any history.",
    isGithubIssue
      ? "Post your findings as COMMENTS on the issue. Do NOT edit the body, do NOT fix anything, and do NOT ask Agent 1 to do board/process work."
      : "Do NOT post board comments yourself and do NOT try to edit Jira. Twindem will record your review verdict/findings on the board after it consumes your signal file.",
    ...(isGithubIssue
      ? [
          `If your verdict is OK, your comment must state it plainly: "✅ REVIEW PASSED (${reachedImplement ? "implementation" : "plan"}) — approved, ready to advance. No further review needed unless the ${reachedImplement ? "code" : "plan"} changes." so anyone reopening the task sees the step is done.`,
          signCommentsLine(signature)
        ]
      : []),
    `Return exactly ONE verdict with STRUCTURED findings: ${isGithubIssue ? "after your comments are posted, " : ""}${signalLine(detail.session.id, "A2", '{"phase":"review","verdict":"OK","findings":[]}')} — replacing OK with "Changes requested" or "Blocked" as appropriate. The file IS your verdict.`,
    'When the verdict is "Changes requested", the findings array MUST contain every finding as {"id":"F1","severity":"blocking|non_blocking","file":"path/if/relevant","line":123,"title":"short title","detail":"what is wrong and why it blocks"}. Use stable ids (F1, F2, ...) and CONTINUE the numbering from your previous round — never reuse an id for a different finding. With verdict OK or Blocked, findings stays [].',
    NO_CHAT_MARKERS
  ].join("\n");
}

// A1: implement the change. Ends ready for code review.
function implementInstruction(
  detail: SessionDetail,
  round: number,
  signature?: string,
  workspace?: TandemConfig["workspaces"][number]
): string {
  const ref = boardArtifactRefForSession(detail.session);
  const type = ideaTypeDefinition(detail.session.ideaType);
  const url = boardArtifactUrlForDetail(detail);
  const body = boardBodyForDetail(detail);
  const provider = detail.board?.provider ?? detail.session.boardProvider ?? "github_project";
  if (!type.requiresImplementation) {
    const workProductExamples =
      type.key === "spike"
        ? "prototype, feasibility proof, experiment notes, findings, recommendation, and follow-up task list"
        : "ADR, research note, runbook, checklist, diagram description, or optional spike ONLY if the issue explicitly requests one";
    const spikeAdrLine =
      type.key === "spike"
        ? "If this spike was derived from an ADR (the task body contains 'Derived from ADR'), update that ADR with the spike conclusions before you signal ready: post a concise conclusion comment on the ADR board issue, or update the ADR document if the source ADR lives in the repo. Include the ADR reference and what changed in your spike task comment."
        : "";
    return [
      `Twindem — ${type.label} work product creation for board task ${ref} (round ${round}).`,
      ...(url ? [`URL: ${url}`] : []),
      ...projectContextLines(workspace),
      ...ideaTypeLines(detail),
      ...(body ? ["Current task body / approved plan (source of truth):", compactPromptBody(body, 7000)] : []),
      provider === "jira"
        ? "This is a Jira task. You cannot read Jira directly from the CLI. Use the task body above; if it is insufficient, ask the human for missing Jira context and WAIT."
        : "Use the current task body/approved plan as the source of truth.",
      `You are Agent 1 (Author). Create the approved ${type.artifact} according to the plan in the issue body.`,
      `This is NOT a default production-coding step. Produce the work product for this ${type.label}: ${workProductExamples}.`,
      ...(spikeAdrLine ? [spikeAdrLine] : []),
      "Keep changes scoped to the approved plan. If you create or update docs, keep them in the appropriate docs path or the path specified by the issue.",
      ...boardCommentProtocolLines(
        detail,
        "Post ONE COMMENT on the issue summarizing the artifact produced, where it lives, evidence gathered, validation performed, open risks, and the recommended next action.",
        signature
      ),
      `Then signal that you are ready for review: ${signalLine(detail.session.id, "A1", isGithubIssueSession(detail) ? '{"phase":"ready"}' : '{"phase":"ready","comment":"<the complete board comment body>"}')}`,
      NO_CHAT_MARKERS
    ].join("\n");
  }
  return [
    `Twindem — implementation for board task ${ref} (round ${round}).`,
    ...(url ? [`URL: ${url}`] : []),
    ...projectContextLines(workspace),
    ...(body ? ["Current task body / approved plan (source of truth):", compactPromptBody(body, 7000)] : []),
    provider === "jira"
      ? "This is a Jira task. You cannot read Jira directly from the CLI. Use the task body above; if it is insufficient, ask the human for missing Jira context and WAIT."
      : "Use the current task body/approved plan as the source of truth.",
    "You are Agent 1 (Implementer). Implement the task per the plan in the issue body.",
    "You are IMPLEMENTING, not planning. The plan is FIXED — do NOT rewrite, re-issue, or edit the issue body/plan, and do NOT re-open planning questions. Just build exactly what the plan says. (If the plan is genuinely unbuildable, stop and say so in a comment instead of re-planning.)",
    "Before changing files, confirm you are inside the workspace root listed above. If the plan points outside that root, STOP and report the mismatch instead of implementing.",
    `First create and switch to a DEDICATED branch for this task inside the workspace repo (e.g. \`task/${detail.session.issueNumber}-short-slug\`); do all work there — never on main.`,
    "Keep changes scoped to the approved plan and the workspace root — no extra refactors, no sibling/external repositories, no out-of-scope edits. Record tests.",
    ...boardCommentProtocolLines(
      detail,
      "Post ONE COMMENT on the issue summarizing what you implemented: the branch name, PR link if one was opened, files/areas changed, and tests run. Do NOT give a verdict and do NOT re-post the plan.",
      signature
    ),
    `Then signal that you are ready for review: ${signalLine(detail.session.id, "A1", isGithubIssueSession(detail) ? '{"phase":"ready"}' : '{"phase":"ready","comment":"<the complete board comment body>"}')}`,
    NO_CHAT_MARKERS
  ].join("\n");
}

function architectureTaskProposalInstruction(
  detail: SessionDetail,
  workspace?: TandemConfig["workspaces"][number]
): string {
  const ref = boardArtifactRefForSession(detail.session);
  const body = detail.board?.body?.trim() || detail.github?.body?.trim() || detail.session.initialBody?.trim();
  const url = boardArtifactUrlForDetail(detail);
  const signalJson =
    '{"phase":"tasks","tasks":[{"title":"Short follow-up task title","type":"feature","summary":"What should be built, fixed, spiked, or documented and why, derived from the accepted ADR.","acceptanceCriteria":"Concrete acceptance criteria.","targetRepo":"optional local repo/path"}]}';
  return [
    `Twindem — propose follow-up tasks for accepted Architecture ADR ${ref}.`,
    ...(url ? [`URL: ${url}`] : []),
    ...projectContextLines(workspace),
    ...ideaTypeLines(detail),
    "You are Agent 1 (Author). The Architecture work product is accepted or at the human approval checkpoint. Your job is to split the accepted ADR into concrete follow-up tasks.",
    "Do NOT create board tasks, branches, commits, labels, comments, or files. Twindem and the human will decide which proposed tasks to create.",
    "Propose only tasks that are direct consequences of the accepted ADR. Skip nice-to-haves, broad epics, and anything that is not actionable by a delivery agent.",
    "Each task must be small enough to review independently and must include acceptance criteria. Use type \"bug\" for corrective work, \"spike\" for time-boxed feasibility/prototype work, \"runbook\" for operational procedure work, \"research\" for non-code discovery, \"architecture\" for a follow-up ADR, and \"feature\" for product implementation.",
    "When proposing a \"spike\" task, its summary or acceptance criteria MUST say which ADR question it answers and that the spike conclusions must be recorded back on this source ADR.",
    body
      ? ["Accepted ADR/task context synced by Twindem:", body].join("\n")
      : isGithubIssueSession(detail)
        ? "If the accepted ADR content is not visible above, use gh ONCE to read the issue body and relevant comments, then stop fetching."
        : "Use only the task context already visible in this session; do not use gh for non-GitHub tasks.",
    `When the proposal is ready, ${signalLine(detail.session.id, "A1", signalJson)}`,
    "The JSON tasks array may contain 1-12 tasks. Keep fields concise; Twindem will normalize and cap oversized text.",
    NO_CHAT_MARKERS
  ].join("\n");
}

type PhaseDef = { key: string; label: string; hint: string };

function phaseActionText(type: ReturnType<typeof ideaTypeDefinition>) {
  if (type.key === "bug") {
    return {
      implementLabel: "Fix",
      implementHint: "Move to In Progress — Agent 1 fixes the defect.",
      inProgressTitle: "In Progress — fix & regression review",
      inProgressBody: "Agent 1 fixes the bug; Agent 2 does regression review. Then Move to UAT.",
      planningBody: "Agent 1 documents reproduction and root cause; Agent 2 reviews. When the plan passes, move to Fix.",
      uatLabel: "Verify fix",
      uatHint: "Move to UAT for bug-fix verification.",
      uatBody: "Verify the fix. When accepted, Move to production.",
      doneLabel: "Confirm fixed",
      doneHint: "Move to Done when the fix is confirmed."
    };
  }
  if (type.key === "spike") {
    return {
      implementLabel: "Run spike",
      implementHint: "Move to In Progress — Agent 1 runs the approved prototype or feasibility experiment.",
      inProgressTitle: "In Progress — spike",
      inProgressBody: "Agent 1 runs the spike; Agent 2 reviews the evidence and recommendation. Then Move to UAT for the decision checkpoint.",
      planningBody: "Agent 1 defines the question, scope, and experiment plan; Agent 2 reviews. When the plan passes, Run spike.",
      uatLabel: "Decision checkpoint",
      uatHint: "Move to UAT for the human decision checkpoint.",
      uatBody: "Review the spike outcome and decide the follow-up. When accepted, move to Done.",
      doneLabel: "Accept spike",
      doneHint: "Move to Done when the spike outcome is accepted."
    };
  }
  if (type.key === "architecture") {
    return {
      implementLabel: "Create ADR",
      implementHint: "Move to In Progress — Agent 1 creates the approved ADR / technical decision artifact.",
      inProgressTitle: "In Progress — create ADR",
      inProgressBody: "Agent 1 creates the ADR/work product; Agent 2 challenge-reviews it. Then Move to UAT for human approval.",
      planningBody: "Agent 1 drafts the ADR plan; Agent 2 reviews assumptions and risks. When the plan passes, Create ADR.",
      uatLabel: "Approve ADR",
      uatHint: "Move to UAT for human or stakeholder approval.",
      uatBody: "Get human/stakeholder approval for the ADR. When accepted, move to Done.",
      doneLabel: "Accept ADR",
      doneHint: "Move to Done when the ADR is accepted."
    };
  }
  if (type.key === "research") {
    return {
      implementLabel: "Research",
      implementHint: "Move to In Progress — Agent 1 performs the approved research.",
      inProgressTitle: "In Progress — research",
      inProgressBody: "Agent 1 produces findings and a recommendation; Agent 2 critiques them. Then Move to UAT for the decision checkpoint.",
      planningBody: "Agent 1 defines research questions and scope; Agent 2 reviews. When the plan passes, start Research.",
      uatLabel: "Decision checkpoint",
      uatHint: "Move to UAT for the human decision checkpoint.",
      uatBody: "Review the recommendation and make the decision. When accepted, move to Done.",
      doneLabel: "Accept recommendation",
      doneHint: "Move to Done when the recommendation is accepted."
    };
  }
  if (type.key === "runbook") {
    return {
      implementLabel: "Draft runbook",
      implementHint: "Move to In Progress — Agent 1 drafts the approved procedure / checklist.",
      inProgressTitle: "In Progress — draft runbook",
      inProgressBody: "Agent 1 drafts the runbook; Agent 2 reviews safety and reliability. Then Move to UAT for dry-run validation.",
      planningBody: "Agent 1 defines scope and preconditions; Agent 2 reviews. When the plan passes, Draft runbook.",
      uatLabel: "Dry-run",
      uatHint: "Move to UAT for dry-run or validation.",
      uatBody: "Validate the runbook with a dry-run or review. When approved, move to Done.",
      doneLabel: "Approve runbook",
      doneHint: "Move to Done when the runbook is approved."
    };
  }
  return {
    implementLabel: "Implement",
    implementHint: "Move to In Progress — Agent 1 implements.",
    inProgressTitle: "In Progress — implement & code-review",
    inProgressBody: "Agent 1 implements; Agent 2 code-reviews. Merge PRs, then Move to UAT.",
    planningBody: "Agent 1 plans; Agent 2 reviews. When the plan passes, Move to Implement.",
    uatLabel: "Move to UAT",
    uatHint: "Move to UAT for testing.",
    uatBody: "Validate in UAT. When ready, merge PRs, then Move to production.",
    doneLabel: "Move to production",
    doneHint: "Move to Done (production)."
  };
}

function statusTextForIdeaType(ideaType?: string | null): Partial<Record<BoardStatusSlot, string>> {
  const type = ideaTypeDefinition(ideaType);
  const text = phaseActionText(type);
  if (type.requiresImplementation) {
    return {
      inbox: "Inbox",
      planning: "Planning",
      in_progress: text.implementLabel,
      review: type.key === "bug" ? "Regression review" : "Review",
      uat: text.uatLabel,
      done: type.key === "bug" ? "Fixed" : "Done"
    };
  }
  return {
    inbox: "Inbox",
    planning: type.key === "architecture" ? "ADR plan" : "Planning",
    in_progress: text.implementLabel,
    review: type.key === "architecture" ? "Challenge review" : type.phases.review,
    uat: text.uatLabel,
    done: type.key === "architecture" ? "ADR accepted" : text.doneLabel
  };
}

// The manual macro-gates the human drives. Agent review ping-pong happens within each phase.
function phaseDefsForIdeaType(ideaType?: string | null): PhaseDef[] {
  const type = ideaTypeDefinition(ideaType);
  const text = phaseActionText(type);
  return [
    { key: "create", label: "Create task", hint: "Create the board task from the idea (Inbox)." },
    { key: "plan", label: "Refinement", hint: `Move to Planning — ${type.phases.planning}, reviewed by Agent 2.` },
    { key: "implement", label: text.implementLabel, hint: text.implementHint },
    { key: "uat", label: text.uatLabel, hint: text.uatHint },
    { key: "prod", label: text.doneLabel, hint: text.doneHint }
  ];
}

function phaseReachedFromStatus(status?: string | null, workspace?: TandemConfig["workspaces"][number]): number {
  return phaseIndexForSlot(slotForBoardStatus(status, workspace));
}

// Release Operator: deploy following the operator-written runbook from Settings. The runbook is
// sensitive local data — passed only to the local agent CLI, never anywhere else.
function releaseOpsInstruction(
  detail: SessionDetail,
  target: "UAT" | "PRODUCTION",
  runbook: string,
  signature?: string,
  workspace?: TandemConfig["workspaces"][number]
): string {
  const ref = boardArtifactRefForSession(detail.session);
  const url = boardArtifactUrlForDetail(detail);
  const signalJson =
    target === "PRODUCTION"
      ? isGithubIssueSession(detail)
        ? '{"phase":"released","summary":"<release evidence summary>"}'
        : '{"phase":"released","summary":"<release evidence summary>","comment":"<the complete board comment body>"}'
      : isGithubIssueSession(detail)
        ? '{"phase":"deployed","summary":"<release evidence summary>"}'
        : '{"phase":"deployed","summary":"<release evidence summary>","comment":"<the complete board comment body>"}';
  return [
    `Twindem — release to ${target} for board task ${ref}.`,
    ...(url ? [`URL: ${url}`] : []),
    ...projectContextLines(workspace),
    ...releaseDeliveryContextLines(workspace),
    "You are the Release Operator (Agent 2). Follow the operator-provided release instructions below EXACTLY — do not improvise alternative deploy paths. If a step fails, STOP and report instead of working around it.",
    "----- OPERATOR RELEASE INSTRUCTIONS -----",
    runbook,
    "----- END OF INSTRUCTIONS -----",
    "Before executing a runbook that deploys from HEAD/main/a branch archive, verify the exact committed revision that will be shipped. If the reviewed fixes are only uncommitted local workspace changes, STOP and report instead of deploying stale code.",
    ...boardCommentProtocolLines(
      detail,
      "Post a COMMENT on the issue with concrete evidence: commands run, target, result, and any verification performed.",
      signature
    ),
    `On SUCCESS, signal completion so Twindem can advance the task: ${signalLine(detail.session.id, "A2", signalJson)}`,
    "If the release FAILED and you stopped, do NOT write that signal — just leave the evidence comment.",
    NO_CHAT_MARKERS
  ].join("\n");
}

// A1: fix a finding reported during UAT, then re-deploy/re-verify.
function uatFixInstruction(detail: SessionDetail, finding: string, signature?: string): string {
  const ref = boardArtifactRefForSession(detail.session);
  const url = boardArtifactUrlForDetail(detail);
  return [
    `Twindem — a UAT finding was reported on board task ${ref}. The task is back IN PROGRESS so you can fix it.`,
    ...(url ? [`URL: ${url}`] : []),
    finding ? `The finding:\n${finding}` : "Read the latest comment on the issue for the exact finding.",
    "Fix it on the task branch, update/add tests, keep changes scoped to this finding (do NOT re-do the whole task).",
    ...boardCommentProtocolLines(detail, "Post a COMMENT summarizing the fix (what was wrong, what you changed).", signature),
    `When the fix is ready for re-review/re-deploy, ${signalLine(detail.session.id, "A1", isGithubIssueSession(detail) ? '{"phase":"ready"}' : '{"phase":"ready","comment":"<the complete board comment body>"}')}`,
    NO_CHAT_MARKERS
  ].join("\n");
}

// A2: merge the task's open PR(s). The actual merge is gated by the CLI permission prompt.
function mergeInstruction(detail: SessionDetail, signature?: string): string {
  const ref = boardArtifactRefForSession(detail.session);
  const url = boardArtifactUrlForDetail(detail);
  const isGithubIssue = isGithubIssueSession(detail);
  return [
    `Twindem — merge the PR(s) for board task ${ref}.`,
    ...(url ? [`URL: ${url}`] : []),
    "You are Agent 2 (Release Operator). Merge the OPEN pull request(s) that implement or deliver this board task. Do NOT assume the current workspace git root is the repository that owns the PR.",
    "Use task context, recent UAT/release evidence, transcript text, PR URLs, and the release runbook to identify the PR(s). If a full GitHub PR URL is present, use it directly.",
    "For GitHub PR URLs, prefer commands that work without a local remote, for example `gh pr view <url> --json number,state,mergeable,statusCheckRollup,url,headRefName,baseRefName,repository` and `gh pr merge <url> --squash --delete-branch`.",
    `If no PR URL is present, search the expected deployment repo from the release evidence/runbook first; only use a local branch pattern like \`task/${detail.session.issueNumber}-...\` when that repo is actually configured.`,
    "If a merge is BLOCKED (merge conflicts, failing required checks, or required reviews not met), STOP on that PR and report exactly which PR and why — do NOT force-merge or override branch protections.",
    ...boardCommentProtocolLines(
      detail,
      "Post ONE comment on the issue listing what was merged (repo + PR + merge commit) and anything that could not be merged.",
      signature
    ),
    isGithubIssue
      ? `Then ${signalLine(detail.session.id, "A2", '{"phase":"merged","summary":"<repo/pr merged, merge commit, checks, anything not merged>"}')}`
      : `Then ${signalLine(detail.session.id, "A2", '{"phase":"merged","summary":"<repo/pr merged, merge commit, checks, anything not merged>","comment":"<the complete board comment body>"}')}`,
    NO_CHAT_MARKERS
  ].join("\n");
}

// Release Operator: roll back the latest deployment/change for this task.
function rollbackInstruction(detail: SessionDetail, signature?: string): string {
  const ref = boardArtifactRefForSession(detail.session);
  const url = boardArtifactUrlForDetail(detail);
  return [
    `Twindem — ROLLBACK for board task ${ref}.`,
    ...(url ? [`URL: ${url}`] : []),
    "You are the Release Operator. Roll back the most recent change for this task: `git revert` the merge/commit on the affected branch (do NOT rewrite history), or redeploy the previous known-good version.",
    ...boardCommentProtocolLines(detail, "Record exactly what you rolled back (commit/PR + reason) as a COMMENT on the issue.", signature),
    `When done, ${signalLine(detail.session.id, "A2", isGithubIssueSession(detail) ? '{"phase":"rollback"}' : '{"phase":"rollback","comment":"<the complete board comment body>"}')}`,
    NO_CHAT_MARKERS
  ].join("\n");
}

// A1: address the reviewer's latest findings. APPLIES changes, never argues/verdicts.
// With structured findings the round is DELTA-SCOPED: only the open blocking findings are sent,
// inline, instead of asking A1 to re-read the full review thread.
function correctionsInstruction(detail: SessionDetail, round: number, signature?: string, findings?: ReviewFinding[]): string {
  const ref = boardArtifactRefForSession(detail.session);
  const url = boardArtifactUrlForDetail(detail);
  const openFindings = (findings ?? []).filter((finding) => finding.status === "open");
  const findingsBlock =
    openFindings.length > 0
      ? [
          "Address ONLY these findings from Agent 2, by id (blocking ones MUST be fixed; non-blocking only if trivial):",
          ...openFindings.map(findingLine),
          "Do NOT redo or revisit anything outside these findings — everything else already passed review."
        ]
      : isGithubIssueSession(detail)
        ? ["You are Agent 1 (Author). Use gh to read Agent 2's LATEST review comments and address ONLY those findings."]
        : ["You are Agent 1 (Author). Address ONLY the findings Agent 2 raised, using the review context Twindem provided above — do NOT use gh for this task (it is not a GitHub board task)."];
  return [
    `Twindem — apply review corrections for board task ${ref} (round ${round}).`,
    ...(url ? [`URL: ${url}`] : []),
    ...(openFindings.length > 0 ? ["You are Agent 1 (Author)."] : []),
    ...findingsBlock,
    "RESOLVE every point concretely (read the code if needed) — no 'likely/if' left in the plan. Do NOT argue, re-review, or give a verdict.",
    "Re-issue the COMPLETE, corrected plan. It REPLACES the entire issue body: there must be exactly ONE authoritative plan — do NOT append an 'update' section and do NOT leave any previous/superseded text in the body. Output the whole clean plan, not a diff.",
    NO_PROCESS_LINE,
    "Output the full revised plan as a fenced block:",
    "TWINDEM_BODY:",
    "<<<",
    "## Technical plan",
    "(the complete corrected plan — self-contained, replaces the body)",
    ">>>",
    bodyFileLine(detail.session.id),
    openFindings.length > 0
      ? "Then post a SHORT comment listing what you changed per finding id (e.g. 'F1: … F2: …') so the reviewer can verify exactly that delta — nothing more."
      : "Then post a SHORT comment listing what you changed per finding (e.g. '1) … 2) …') so the reviewer can verify a delta — nothing more.",
    signCommentsLine(signature),
    `When the corrections are done, ${signalLine(detail.session.id, "A1", '{"phase":"ready"}')}`,
    NO_CHAT_MARKERS
  ].join("\n");
}

// Extract the proposed issue body the agent emits between TWINDEM_BODY: <<< ... >>>.
// Takes the LAST block (the agent's real output, after any echoed prompt) and rejects the
// echoed prompt template, which is only headings + "..." placeholders.
function parseTwindemBody(output: string): string | null {
  const matches = [...output.matchAll(/TWINDEM_BODY:\s*<<<\s*([\s\S]*?)\s*>>>/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const body = stripAnsi(last[1]).replace(/\r/g, "").trim();
  // Reject the placeholder template (headings + "..." only → not a real analysis).
  const filled = body
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/\.\.\./g, "")
    .replace(/[\s>-]/g, "");
  if (filled.length < 30) return null;
  return body;
}

// Orientation brief sent when an agent is manually Started/Resumed on an existing board task.
// It only ORIENTS (read the issue, summarize, wait) — it never asks for a marker. The real work
// instruction (review / corrections / phase), with its signal-file protocol, arrives from the
// conductor buttons. (Earlier this told agents to emit TWINDEM_RESULT, which Twindem no longer
// reads — the signal-file protocol replaced it.)
function buildSessionContextBrief(
  detail: SessionDetail,
  side: AgentSide,
  workspace?: TandemConfig["workspaces"][number]
): string | null {
  const pack = buildAgentContextPack({ detail, workspace, side, mode: "orientation" });
  return renderAgentContextBrief(pack) || null;
}

function defaultFirstPrompt(
  artifactType: CreateSessionInput["artifactType"],
  repo?: string,
  issueNumber?: number,
  title?: string,
  ideaType?: IdeaType
): string {
  if (artifactType === "idea") return "";
  const artifactRef = repo && issueNumber ? `${repo}#${issueNumber}` : title?.trim() || "the selected artifact";
  const type = ideaTypeDefinition(ideaType);
  const action =
    artifactType === "issue"
      ? `Analyze this ${type.label.toLowerCase()} issue and identify the relevant questions, missing context, risks, affected areas, evidence needs, and review plan.`
      : artifactType === "branch"
        ? "Analyze the work connected to this branch/tracking issue and identify what needs review, validation, or next implementation steps."
        : artifactType === "pr"
          ? "Analyze the PR/tracking issue context and prepare a review plan: scope, risks, test evidence, and questions before approval."
          : "Analyze this release/tracking issue and identify scope, blockers, verification evidence, rollout risk, and release questions.";
  return [
    `Work on ${artifactRef}.`,
    `Idea type: ${type.label}. Expected artifact: ${type.artifact}.`,
    "",
    action,
    "Do not start coding or deploying until the analysis questions and next step are clear."
  ].join("\n");
}

function shouldDisplayAgentCard(card: AgentOutputCard): boolean {
  if (isNoisyAgentOutput(card.body)) return false;
  if (card.kind === "result" || card.kind === "verdict" || card.kind === "artifact") return true;
  if (card.kind === "tool") return card.body.length > 30;
  return card.body.length > 60;
}

function isNoisyAgentOutput(body: string): boolean {
  const normalized = body.trim();
  if (!normalized) return true;
  if (/^M(?:\s*M){3,}$/i.test(normalized)) return true;
  if (/^Tip:\s+/i.test(normalized)) return true;
  if (/^Starting MCP servers/i.test(normalized)) return true;
  if (/^OpenAI Codex/i.test(normalized)) return true;
  if (/\bsetup issue\b/i.test(normalized)) return true;
  if (/\b\/doctor\b/i.test(normalized)) return true;
  if (/\bfor\s*shortcuts\b/i.test(normalized)) return true;
  if (/\b(?:for)?shortcuts\b/i.test(normalized)) return true;
  if (/\b(?:for\s*)?effort\b/i.test(normalized) && /\bhigh\b/i.test(normalized)) return true;
  if (/─{6,}|-{6,}|_{6,}/.test(normalized)) return true;
  if (/model:\s*[^|]+\|\s*directory:/i.test(normalized)) return true;
  if (/^\[\?\d+[a-z]/i.test(normalized)) return true;
  if (/^\|\s*>_/.test(normalized)) return true;
  if (/^\d+\)\s*:/.test(normalized)) return true;
  return false;
}

function compactUiText(value: string, maxLength: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function formatCompactVolume(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function workflowInstructionTemplate(
  config: TandemConfig | null,
  detail: SessionDetail,
  key: string,
  fallback: string
): string {
  if (!config) return fallback;
  const workspace = activeWorkspace(config, detail.session.workspaceName);
  const workflow = config.workflows[workspace?.workflowTemplate ?? ""] ?? config.workflows.default;
  return workflow?.instructionTemplates?.[key]?.trim() || fallback;
}

function deriveConductorState(
  detail: SessionDetail | null,
  workspace?: TandemConfig["workspaces"][number]
): ConductorState {
  if (!detail) {
    return {
      currentStepId: "idea-proposal",
      nextStepId: "idea-review-loop",
      checkpointTitle: "Start with an idea",
      checkpointBody: "Create a new session, then let Agent 1 materialize it into an issue.",
      checkpointTone: "accent",
      primaryAction: "New session",
      round: { n: 1, total: 3 }
    };
  }

  const labels = new Set(detail.github?.labels ?? []);
  const evidence = new Map(detail.evidence.map((item) => [item.key, item.status]));
  const hasIssue = Boolean((detail.session.repo && detail.session.issueNumber) || detail.session.boardItemId || detail.session.boardItemKey);
  const taskReviewOk = labels.has("review-done") || evidence.get("task_review_ok") === "done";
  const taskReviewRequested = labels.has("needs-task-review");
  const changesRequested = labels.has("review-done-please-correct");
  const hasPr = evidence.get("branch_or_pr_linked") === "done" || Boolean(detail.github?.linkedPrs?.length);
  const testsRecorded = evidence.get("tests_recorded") === "done";
  const deployEvidence = evidence.get("deploy_evidence") === "done";
  const persistedStep = detail.conductor?.currentStepId;

  if (!hasIssue) {
    const isIdea = detail.session.artifactType === "idea";
    return {
      currentStepId: isIdea ? "idea-create-task" : "idea-proposal",
      nextStepId: "idea-review-loop",
      checkpointTitle: isIdea ? "Shape the idea, then create the task" : "Materialize the idea",
      checkpointBody: isIdea
        ? "Discuss with Agent 1. When the idea is clear, create the board task — Agent 2 stays inactive until then."
        : "Create or attach a board task before the review loop starts.",
      checkpointTone: "amber",
      primaryAction: isIdea ? "Create task" : "Attach issue",
      marker: isIdea ? undefined : "required: issue_linked",
      round: { n: detail.session.roundN, total: detail.session.roundTotal }
    };
  }

  // The BOARD STATUS is the source of truth. Derive the step from it when the task has moved past
  // Inbox — the conductor's currentStepId often lags (e.g. stuck at "inbox-analysis" in UAT).
  const round = { n: detail.session.roundN, total: detail.session.roundTotal };
  const type = ideaTypeDefinition(detail.session.ideaType);
  const phaseText = phaseActionText(type);
  const sourceStatus = boardStatusForSession(detail);
  if (isRealBoardStatus(sourceStatus)) {
    const boardPhase = sessionPhaseReached(detail, workspace);
    if (boardPhase >= 4) {
      return { currentStepId: "done", nextStepId: "done", checkpointTitle: "Done", checkpointBody: "The task is in Done.", checkpointTone: "green", primaryAction: "—", round };
    }
    if (boardPhase === 3) {
      return { currentStepId: "uat", nextStepId: "prod-gate", checkpointTitle: "In UAT", checkpointBody: phaseText.uatBody, checkpointTone: "accent", primaryAction: phaseText.doneLabel, round };
    }
    if (boardPhase === 2) {
      return { currentStepId: "implementation", nextStepId: "uat-gate", checkpointTitle: phaseText.inProgressTitle, checkpointBody: phaseText.inProgressBody, checkpointTone: "accent", primaryAction: "Review → A2", round };
    }
    if (boardPhase === 1) {
      return { currentStepId: "planning", nextStepId: "implement-gate", checkpointTitle: "Refinement — plan & review", checkpointBody: phaseText.planningBody, checkpointTone: "accent", primaryAction: "Review → A2", round };
    }
  }

  if (persistedStep === "inbox-analysis") {
    return {
      currentStepId: "inbox-analysis",
      nextStepId: "inbox-review",
      checkpointTitle: "Task ready — start Refinement",
      checkpointBody: "Use the phase buttons: move to Refinement so Agent 1 plans, then Review → A2.",
      checkpointTone: "accent",
      primaryAction: "Start analysis (Agent 1)",
      marker: "stop signal: ready (signal file)",
      round: { n: detail.conductor?.ideaRound ?? detail.session.roundN, total: detail.session.roundTotal }
    };
  }

  if (persistedStep === "inbox-review") {
    return {
      currentStepId: "inbox-review",
      nextStepId: "planning-gate",
      checkpointTitle: "Review the planning",
      checkpointBody: "Agent 2 reviews the task body and posts findings as comments, then writes its verdict signal file.",
      checkpointTone: "accent",
      primaryAction: "Handoff to Agent 2 — review",
      marker: "stop signal: review verdict (signal file)",
      round: { n: detail.conductor?.ideaRound ?? detail.session.roundN, total: detail.session.roundTotal }
    };
  }

  if (detail.session.visiblePhase === "capture") {
    return {
      currentStepId: "idea-review-loop",
      nextStepId: "planning-gate",
      checkpointTitle: "Route idea to reviewer",
      checkpointBody: "The issue exists in Inbox. Agent 2 should review the idea before planning starts.",
      checkpointTone: "accent",
      primaryAction: "Start review",
      marker: "stop marker: IDEA APPROVED",
      round: { n: detail.conductor?.ideaRound ?? detail.session.roundN, total: detail.session.roundTotal }
    };
  }

  if (persistedStep === "implementation") {
    return {
      currentStepId: "implementation",
      nextStepId: "code-review-loop",
      checkpointTitle: `${phaseText.implementLabel} selected`,
      checkpointBody: type.requiresImplementation
        ? "The chosen implementer should write the change, record tests, and produce branch/PR evidence."
        : `Agent 1 should create the approved ${type.artifact}, record evidence, and prepare it for challenge review.`,
      checkpointTone: "accent",
      primaryAction: `Start ${phaseText.implementLabel.toLowerCase()}`,
      marker: type.requiresImplementation ? "stop marker: IMPLEMENTATION READY" : "stop marker: work product ready",
      round: { n: detail.conductor?.codeRound ?? detail.session.roundN, total: detail.session.roundTotal }
    };
  }

  if (persistedStep === "code-review-loop") {
    return {
      currentStepId: "code-review-loop",
      nextStepId: "uat-gate",
      checkpointTitle: type.requiresImplementation ? "Code review loop" : `${type.label} review loop`,
      checkpointBody: type.requiresImplementation
        ? "Reviewer should inspect implementation and stop only at CODE APPROVED."
        : `Reviewer should challenge the ${type.artifact}, risks, assumptions, and evidence before human approval.`,
      checkpointTone: "accent",
      primaryAction: type.requiresImplementation ? "Start code review" : "Start challenge review",
      marker: type.requiresImplementation ? "stop marker: CODE APPROVED" : "stop marker: review verdict",
      round: { n: detail.conductor?.codeRound ?? detail.session.roundN, total: detail.session.roundTotal }
    };
  }

  if (taskReviewRequested || changesRequested) {
    return {
      currentStepId: "idea-review-loop",
      nextStepId: "planning-gate",
      checkpointTitle: changesRequested ? "Send corrections back to Agent 1" : "Route idea to reviewer",
      checkpointBody: changesRequested
        ? "Reviewer requested corrections. Agent 1 should update the issue body, then request review again."
        : "The issue is in task review. Start Agent 2 with the review briefing.",
      checkpointTone: changesRequested ? "amber" : "accent",
      primaryAction: changesRequested ? "Send to Agent 1" : "Start review",
      marker: "stop marker: IDEA APPROVED",
      round: { n: detail.session.roundN, total: detail.session.roundTotal }
    };
  }

  if (taskReviewOk && detail.session.visiblePhase !== "execute" && detail.session.visiblePhase !== "verify" && detail.session.visiblePhase !== "done") {
    return {
      currentStepId: "planning-gate",
      nextStepId: "technical-analysis",
      checkpointTitle: "Start planning?",
      checkpointBody: "The idea definition passed review. Human approval should start technical analysis.",
      checkpointTone: "green",
      primaryAction: "Start planning",
      marker: "IDEA APPROVED",
      round: { n: detail.session.roundN, total: detail.session.roundTotal }
    };
  }

  if (detail.session.visiblePhase === "execute") {
    if (!type.requiresImplementation || !hasPr || !testsRecorded) {
      return {
        currentStepId: "implementation",
        nextStepId: "code-review-loop",
        checkpointTitle: `${phaseText.implementLabel} running`,
        checkpointBody: type.requiresImplementation
          ? "Implementer should produce code, PR/branch link, and tests before code review."
          : `Agent 1 should produce the ${type.artifact}, then request challenge review.`,
        checkpointTone: "accent",
        primaryAction: `Start ${phaseText.implementLabel.toLowerCase()}`,
        marker: type.requiresImplementation ? "required: PR + tests" : `required: ${type.artifact}`,
        round: { n: detail.session.roundN, total: detail.session.roundTotal }
      };
    }
    return {
      currentStepId: "code-review-loop",
      nextStepId: "uat-gate",
      checkpointTitle: "Request code review",
      checkpointBody: "Reviewer should inspect the implementation and stop only at CODE APPROVED.",
      checkpointTone: "accent",
      primaryAction: "Start code review",
      marker: "stop marker: CODE APPROVED",
      round: { n: detail.session.roundN, total: detail.session.roundTotal }
    };
  }

  if (detail.session.visiblePhase === "verify") {
    if (!type.requiresImplementation) {
      return {
        currentStepId: "uat-approval",
        nextStepId: "done-gate",
        checkpointTitle: phaseText.uatLabel,
        checkpointBody: `Human/stakeholder approval is required before this ${type.label.toLowerCase()} task can be accepted.`,
        checkpointTone: "amber",
        primaryAction: phaseText.doneLabel,
        marker: "human approval",
        round: { n: detail.session.roundN, total: detail.session.roundTotal }
      };
    }
    return {
      currentStepId: deployEvidence ? "uat-validation" : "uat-deploy",
      nextStepId: deployEvidence ? undefined : "uat-validation",
      checkpointTitle: deployEvidence ? "Validate UAT" : "Approve UAT deploy",
      checkpointBody: deployEvidence
        ? "UAT deploy evidence exists. Run smoke/UAT validation before final sign-off."
        : "Deploy is an environment action and must pass a human gate.",
      checkpointTone: deployEvidence ? "green" : "amber",
      primaryAction: deployEvidence ? "Record validation" : "Move UAT",
      marker: deployEvidence ? "required: smoke tests" : "human gate",
      round: { n: detail.session.roundN, total: detail.session.roundTotal }
    };
  }

  return {
    currentStepId: "technical-analysis",
    nextStepId: "technical-review-loop",
    checkpointTitle: "Continue definition",
    checkpointBody: "Agent 1 should update the task with technical analysis, then request technical review.",
    checkpointTone: "accent",
    primaryAction: "Request review",
    marker: "stop marker: DOR MET",
    round: { n: detail.session.roundN, total: detail.session.roundTotal }
  };
}

function deriveTurnIndicator(detail: SessionDetail | null, state: ConductorState): TurnIndicator {
  if (!detail) return { kind: "none" };
  const step = NATIVE_FLOW_STEPS.find((candidate) => candidate.id === state.currentStepId);
  if (step?.kind === "gate" || state.checkpointTone === "amber") return { kind: "human" };
  if (detail.conductor?.activeSide) return { kind: "agent", side: detail.conductor.activeSide };
  if (step?.kind === "agent1") return { kind: "agent", side: "L" };
  if (step?.kind === "agent2") return { kind: "agent", side: "R" };
  if (state.currentStepId === "idea-review-loop" || state.currentStepId === "technical-review-loop") {
    return { kind: "agent", side: "R" };
  }
  if (state.currentStepId === "code-review-loop") return { kind: "agent", side: "L" };
  return { kind: "none" };
}

interface SessionWelcome {
  canResume: boolean;
  activeSide: AgentSide;
  stepLabel: string;
  issueTitle: string | null;
  hasHistory: boolean;
}

function deriveSessionWelcome(
  detail: SessionDetail | null,
  workspace?: TandemConfig["workspaces"][number]
): SessionWelcome | null {
  if (!detail) return null;
  const hasRuns = detail.runs.length > 0;
  const hasCards = detail.transcript.length > 0;
  if (!hasRuns && !hasCards) return null;
  const activeSide = detail.conductor?.activeSide ?? "L";
  const canResume = canResumeAgent(detail, activeSide);
  // Show the live board status (source of truth) as the step, not the stale conductor step.
  const sourceStatus = boardStatusForSession(detail);
  const stepLabel = isRealBoardStatus(sourceStatus)
    ? sourceStatus!.trim()
    : statusLabelForVisiblePhase(detail.session.visiblePhase, workspace) || detail.conductor?.currentStepId?.replace(/-/g, " ") || "starting";
  const issueTitle = detail.github?.title ?? detail.session.title ?? null;
  return { canResume, activeSide, stepLabel, issueTitle, hasHistory: hasRuns || hasCards };
}

function deriveRestoreState(detail: SessionDetail | null): { side: AgentSide; label: string; description: string } | null {
  if (!detail) return null;
  const activeSide = detail.conductor?.activeSide;
  const activeRun = activeSide ? latestRunForSide(detail, activeSide) : undefined;
  const interruptedRun = detail.runs.find((run) => run.status === "interrupted");
  const targetSide = activeRun?.side ?? interruptedRun?.side ?? activeSide;
  if (!targetSide) return null;
  const targetRun = latestRunForSide(detail, targetSide);
  if (!detail.conductor?.restorePending && targetRun?.status !== "interrupted") return null;
  if (!targetRun?.nativeSessionId) return null;
  const label = targetSide === "L" ? "Agent 1" : "Agent 2";
  return {
    side: targetSide,
    label,
    description: `Native session ${targetRun.nativeSessionId} is saved for ${label}. Resume continues that agent for this Twindem task.`
  };
}

function groupFlowByStatus(steps: NativeFlowStep[]): Array<[NativeFlowStep["status"], NativeFlowStep[]]> {
  const groups = new Map<NativeFlowStep["status"], NativeFlowStep[]>();
  for (const step of steps) {
    groups.set(step.status, [...(groups.get(step.status) ?? []), step]);
  }
  return Array.from(groups.entries());
}

function parseIssueRef(ref: string): { repo: string; issueNumber: number } | null {
  const trimmed = ref.trim();
  const urlMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[#?].*)?$/);
  const hashMatch = trimmed.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  const pathMatch = trimmed.match(/^([^/\s]+\/[^/\s]+)\/issues\/(\d+)$/);
  const match = urlMatch ?? hashMatch ?? pathMatch;
  if (!match) return null;
  return { repo: match[1], issueNumber: Number(match[2]) };
}

function parseIssueRefsFromText(text: string): Array<{ repo: string; issueNumber: number }> {
  const refs = new Map<string, { repo: string; issueNumber: number }>();
  const pattern = /https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/issues\/(\d+)(?:[#?][^\s)]*)?/g;
  for (const match of text.matchAll(pattern)) {
    const repo = match[1];
    const issueNumber = Number(match[2]);
    refs.set(`${repo}#${issueNumber}`, { repo, issueNumber });
  }
  return Array.from(refs.values());
}

function rolesFromPaneDefault(
  pane: TandemConfig["defaults"]["leftPane"],
  fallback?: string[]
): string[] {
  return normalizeRoles(pane.roles?.length ? pane.roles : [pane.role], fallback);
}

function uniqueAllowedRoles(roles: string[], allRoles: string[]): string[] {
  const allowed = new Set(allRoles);
  const seen = new Set<string>();
  return roles
    .map((role) => role.trim())
    .filter((role) => role && allowed.has(role))
    .filter((role) => {
      if (seen.has(role)) return false;
      seen.add(role);
      return true;
    });
}

function completeRolePartition(
  leftRoles: string[],
  rightRoles: string[],
  allRoles: string[]
): Record<AgentSide, string[]> {
  const left = uniqueAllowedRoles(leftRoles, allRoles);
  const right = uniqueAllowedRoles(rightRoles, allRoles).filter((role) => !left.includes(role));
  const missing = allRoles.filter((role) => !left.includes(role) && !right.includes(role));
  const nextRight = [...right, ...missing];
  if (left.length === 0 && nextRight.length > 1) {
    const moved = nextRight.shift()!;
    left.push(moved);
  }
  if (nextRight.length === 0 && left.length > 1) {
    nextRight.push(left.pop()!);
  }
  return {
    L: left.length > 0 ? left : allRoles.slice(0, 1),
    R: nextRight.length > 0 ? nextRight : allRoles.slice(1, 2)
  };
}

function partitionRolesForSide(
  side: AgentSide,
  requestedRoles: string[],
  currentLeftRoles: string[],
  currentRightRoles: string[],
  allRoles: string[]
): Record<AgentSide, string[]> {
  const active = uniqueAllowedRoles(requestedRoles, allRoles);
  const otherCurrent = side === "L" ? currentRightRoles : currentLeftRoles;
  const other = uniqueAllowedRoles(otherCurrent, allRoles).filter((role) => !active.includes(role));
  const missing = allRoles.filter((role) => !active.includes(role) && !other.includes(role));
  other.push(...missing);

  const nextActive = [...active];
  if (nextActive.length === 0 && other.length > 1) {
    nextActive.push(other.shift()!);
  }
  if (other.length === 0 && nextActive.length > 1) {
    other.push(nextActive.pop()!);
  }

  return side === "L"
    ? { L: nextActive, R: other }
    : { L: other, R: nextActive };
}

function rolePartitionIssue(leftRoles: string[], rightRoles: string[], allRoles: string[]): string | null {
  const left = uniqueAllowedRoles(leftRoles, allRoles);
  const right = uniqueAllowedRoles(rightRoles, allRoles);
  const duplicated = left.filter((role) => right.includes(role));
  if (duplicated.length > 0) return `Each role can belong to only one agent. Duplicated: ${duplicated.join(", ")}.`;
  const covered = new Set([...left, ...right]);
  const missing = allRoles.filter((role) => !covered.has(role));
  if (missing.length > 0) return `All roles must be assigned to one agent. Missing: ${missing.join(", ")}.`;
  if (left.length === 0 || right.length === 0) return "Each agent needs at least one role.";
  return null;
}

function normalizeConfigRolePartition(config: TandemConfig): TandemConfig {
  const partition = completeRolePartition(
    rolesFromPaneDefault(config.defaults.leftPane, DEFAULT_AGENT_1_ROLES),
    rolesFromPaneDefault(config.defaults.rightPane, DEFAULT_AGENT_2_ROLES),
    Object.keys(config.roles)
  );
  return {
    ...config,
    defaults: {
      ...config.defaults,
      leftPane: {
        ...config.defaults.leftPane,
        role: partition.L[0],
        roles: partition.L
      },
      rightPane: {
        ...config.defaults.rightPane,
        role: partition.R[0],
        roles: partition.R
      }
    }
  };
}

function normalizeRoles(roles: string[], fallback?: string[]): string[] {
  const seen = new Set<string>();
  const normalized = roles.map((role) => role.trim()).filter(Boolean).filter((role) => {
    if (seen.has(role)) return false;
    seen.add(role);
    return true;
  });
  return normalized.length > 0 ? normalized : fallback?.filter(Boolean) ?? ["Agent"];
}

function roleLabel(roles: string[]): string {
  return normalizeRoles(roles).join(" + ");
}

function parseRoleLabel(value: string): string[] {
  return normalizeRoles(value.split(/\s+\+\s+|,\s*/));
}

function providerDisplay(provider?: TandemConfig["providers"][string]): string {
  if (!provider) return "No profile";
  const model = provider.model ?? provider.version;
  return model && model !== "default" ? `${provider.label} · ${model}` : provider.label;
}

function providerOptionLabel(key: string, provider: TandemConfig["providers"][string]): string {
  const model = provider.model ?? provider.version;
  const version = model && model !== "default" ? model : provider.label;
  return `${version}  ${provider.command || key}`;
}

function providerGroups(
  config: TandemConfig | null,
  selectedKey?: string
): Array<[string, Array<[string, TandemConfig["providers"][string]]>]> {
  const groups = new Map<string, Array<[string, TandemConfig["providers"][string]]>>();
  const seenSignatures = new Map<string, string>();
  for (const entry of Object.entries(config?.providers ?? {})) {
    const [key, provider] = entry;
    const signature = [
      providerFamily(provider),
      provider.command,
      (provider.args ?? []).join("\u0000"),
      provider.model ?? provider.version ?? "",
      provider.authMode ?? ""
    ].join("\u0001");
    const existingKey = seenSignatures.get(signature);
    if (existingKey && key !== selectedKey) continue;
    if (existingKey && key === selectedKey) {
      for (const [group, entries] of groups) {
        const index = entries.findIndex(([candidateKey]) => candidateKey === existingKey);
        if (index >= 0) {
          groups.set(group, entries.filter((_, candidateIndex) => candidateIndex !== index));
          break;
        }
      }
    }
    seenSignatures.set(signature, key);
    const label = provider.label || provider.command || "Custom CLI";
    const group = label.toLowerCase().includes("claude")
      ? "Claude"
      : label.toLowerCase().includes("codex")
        ? "Codex"
        : label.toLowerCase().includes("shell") || provider.command === "zsh" || provider.command === "bash"
          ? "Shell"
          : "Custom CLI";
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  const order = ["Codex", "Claude", "Shell", "Custom CLI"];
  return order
    .filter((group) => groups.has(group))
    .map((group) => [group, groups.get(group)!]);
}

function splitArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of value.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }

    if (quote === char) {
      quote = null;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

function uniqueProviderKey(config: TandemConfig, prefix: string): string {
  let index = 1;
  let key = `${prefix}-${index}`;
  while (config.providers[key]) {
    index += 1;
    key = `${prefix}-${index}`;
  }
  return key;
}

function uniqueWorkspaceName(config: TandemConfig, prefix: string): string {
  let index = 1;
  let name = `${prefix} ${index}`;
  while (config.workspaces.some((workspace) => workspace.name === name)) {
    index += 1;
    name = `${prefix} ${index}`;
  }
  return name;
}
