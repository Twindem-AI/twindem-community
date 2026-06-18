import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tandemDatabasePath } from "./paths.js";
import type {
  AgentRunSummary,
  AgentSide,
  ComposerMessageInput,
  ConductorSnapshot,
  CreateSessionInput,
  DeployAttempt,
  EvidenceItem,
  EvidenceRecord,
  EvidenceRecordInput,
  EvidenceRecordKind,
  EvidenceStatus,
  BoardArtifact,
  GitHubIssueContext,
  Handoff,
  NativeOutputCard,
  NativeOutputCardInput,
  SessionDetail,
  SessionSummary,
  TranscriptEvent,
  UpdateSessionInput,
  UsageEvent,
  UsageSummary,
  WorkflowEvent
} from "../../shared/domain.js";
import type { BoardStatusSlot, TandemConfig } from "../../shared/config.js";
import { inferIdeaType } from "../../shared/idea-types.js";
import { sessionStateForSlot, slotForBoardStatus } from "../../shared/status-mapping.js";

type Db = Database.Database;
type HandoffRow = Omit<Handoff, "evidence"> & { evidenceJson: string };
type DeployAttemptRow = Omit<DeployAttempt, "args"> & { argsJson: string };
type EvidenceRecordRow = Omit<EvidenceRecord, "details"> & { detailsJson?: string };

// Hard cap on narrative evidence summaries: the full content belongs in rawRef/rawPath, never in
// the summary that gets rendered in the drawer and injected into prompts.
const EVIDENCE_SUMMARY_MAX = 2000;

const evidenceTitles: Record<string, string> = {
  issue_linked: "Issue linked",
  task_body_complete: "Task body complete",
  task_review_ok: "Task review OK",
  branch_or_pr_linked: "Branch or PR linked",
  tests_recorded: "Tests recorded",
  pr_review_approved: "PR review approved",
  deploy_evidence: "Deploy evidence",
  smoke_tests_recorded: "Smoke tests recorded",
  final_verification_comment: "Final verification comment"
};

const ACTIVE_SESSION_SETTING_KEY = "active_session_id";

type UsageSummaryRow = {
  side?: AgentSide;
  provider?: string;
  model?: string;
  phase: string;
  input: number;
  output: number;
};

function usageSummaryFromRows(rows: UsageSummaryRow[]): UsageSummary | undefined {
  if (rows.length === 0) return undefined;

  const byAgentMap = new Map<string, UsageSummary["byAgent"][number]>();
  const byPhaseMap = new Map<string, UsageSummary["byPhase"][number]>();
  let inputTotal = 0;
  let outputTotal = 0;
  for (const row of rows) {
    inputTotal += row.input;
    outputTotal += row.output;
    const agentKey = `${row.side ?? ""}|${row.provider ?? ""}|${row.model ?? ""}`;
    const agent = byAgentMap.get(agentKey) ?? {
      side: row.side ?? undefined,
      provider: row.provider ?? undefined,
      model: row.model ?? undefined,
      totalEstimateTokens: 0
    };
    agent.totalEstimateTokens += row.input + row.output;
    byAgentMap.set(agentKey, agent);
    const phase = byPhaseMap.get(row.phase) ?? { phase: row.phase, totalEstimateTokens: 0 };
    phase.totalEstimateTokens += row.input + row.output;
    byPhaseMap.set(row.phase, phase);
  }
  return {
    inputEstimateTokens: inputTotal,
    outputEstimateTokens: outputTotal,
    totalEstimateTokens: inputTotal + outputTotal,
    byAgent: Array.from(byAgentMap.values()),
    byPhase: Array.from(byPhaseMap.values())
  };
}

type WorkspaceConfig = TandemConfig["workspaces"][number];

function mapProjectStatus(projectStatus: string, workspace?: WorkspaceConfig): {
  visiblePhase: string;
  internalState: string;
  sessionStatus: string;
} {
  return sessionStateForSlot(slotForBoardStatus(projectStatus, workspace) ?? "planning");
}

export class TandemDatabase {
  private readonly db: Db;

  constructor(path = tandemDatabasePath()) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  listSessions(): SessionSummary[] {
    return this.db
      .prepare(
        `SELECT id, title, initial_body as initialBody, artifact_type as artifactType, repo_owner || '/' || repo_name as repo,
                idea_type as ideaType,
                issue_number as issueNumber, pr_number as prNumber,
                board_provider as boardProvider, board_item_id as boardItemId,
                board_item_key as boardItemKey, board_item_url as boardItemUrl,
                board_status as boardStatus,
                workspace_name as workspaceName,
                left_role as leftRole, left_provider as leftProvider,
                right_role as rightRole, right_provider as rightProvider,
                dangerously_skip_permissions as dangerouslySkipPermissions,
                visible_phase as visiblePhase, internal_state as internalState, status,
                round_n as roundN, round_total as roundTotal,
                created_at as createdAt, updated_at as updatedAt,
                last_github_sync_at as lastGithubSyncAt,
                spawned_from_session_id as spawnedFromSessionId,
                spawned_from_task_id as spawnedFromTaskId,
                spawned_fingerprint as spawnedFingerprint,
                spawned_from_board_ref as spawnedFromBoardRef,
                spawned_order as spawnedOrder,
                (SELECT COUNT(*) FROM agent_runs WHERE agent_runs.session_id = sessions.id) as agentRunCount,
                COALESCE(hidden, 0) as hidden
           FROM sessions
          ORDER BY updated_at DESC`
      )
      .all()
      .map((row) => {
        const r = row as SessionSummary & { hidden?: number; dangerouslySkipPermissions?: number | null };
        return {
          ...r,
          agentRunCount: Number(r.agentRunCount ?? 0),
          hidden: Boolean(r.hidden),
          dangerouslySkipPermissions: r.dangerouslySkipPermissions == null ? undefined : Boolean(r.dangerouslySkipPermissions)
        } as SessionSummary;
      });
  }

  setSessionHidden(id: string, hidden: boolean): void {
    this.db.prepare(`UPDATE sessions SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, id);
  }

  // Dedupe for spawned follow-up tasks: a given proposed task (by fingerprint) gets at most one session.
  findSessionIdBySpawnedFingerprint(fingerprint: string): string | null {
    if (!fingerprint) return null;
    const row = this.db
      .prepare(`SELECT id FROM sessions WHERE spawned_fingerprint = ? LIMIT 1`)
      .get(fingerprint) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // Dedupe by the board item a session is linked to (any provider) — so a backfill / re-run never
  // creates a second session for an item that already has one (including ones opened from the board).
  findSessionIdByBoardIdentity(opts: {
    repo?: string;
    issueNumber?: number;
    boardItemId?: string;
    boardItemKey?: string;
  }): string | null {
    if (opts.repo && opts.issueNumber) {
      const [owner, name] = opts.repo.split("/");
      const row = this.db
        .prepare(`SELECT id FROM sessions WHERE repo_owner = ? AND repo_name = ? AND issue_number = ? LIMIT 1`)
        .get(owner, name, opts.issueNumber) as { id: string } | undefined;
      if (row) return row.id;
    }
    if (opts.boardItemId) {
      const row = this.db
        .prepare(`SELECT id FROM sessions WHERE board_item_id = ? LIMIT 1`)
        .get(opts.boardItemId) as { id: string } | undefined;
      if (row) return row.id;
    }
    if (opts.boardItemKey) {
      const row = this.db
        .prepare(`SELECT id FROM sessions WHERE board_item_key = ? LIMIT 1`)
        .get(opts.boardItemKey) as { id: string } | undefined;
      if (row) return row.id;
    }
    return null;
  }

  boardArtifactForSession(id: string): BoardArtifact | null {
    return this.getBoardArtifact(id) ?? null;
  }

  findSessionByIssue(repoFullName: string, issueNumber: number): SessionDetail | null {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) return null;
    const row = this.db
      .prepare(
        `SELECT id
           FROM sessions
          WHERE repo_owner = ?
            AND repo_name = ?
            AND issue_number = ?
          ORDER BY updated_at DESC
          LIMIT 1`
      )
      .get(owner, repo, issueNumber) as { id: string } | undefined;
    return row ? this.getSession(row.id) : null;
  }

  getActiveSessionId(): string | null {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(ACTIVE_SESSION_SETTING_KEY) as { value: string } | undefined;
    if (!row?.value) return null;
    const exists = this.db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(row.value);
    return exists ? row.value : null;
  }

  setActiveSessionId(id: string | null): void {
    if (!id) {
      this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(ACTIVE_SESSION_SETTING_KEY);
      return;
    }
    const exists = this.db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(id);
    if (!exists) throw new Error("Session not found");
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(ACTIVE_SESSION_SETTING_KEY, id, new Date().toISOString());
  }

  getSession(id: string): SessionDetail | null {
    const session = this.db
      .prepare(
        `SELECT id, title, initial_body as initialBody, artifact_type as artifactType, repo_owner || '/' || repo_name as repo,
                idea_type as ideaType,
                issue_number as issueNumber, pr_number as prNumber,
                board_provider as boardProvider, board_item_id as boardItemId,
                board_item_key as boardItemKey, board_item_url as boardItemUrl,
                workspace_name as workspaceName,
                left_role as leftRole, left_provider as leftProvider,
                right_role as rightRole, right_provider as rightProvider,
                dangerously_skip_permissions as dangerouslySkipPermissions,
                visible_phase as visiblePhase, internal_state as internalState, status,
                round_n as roundN, round_total as roundTotal,
                created_at as createdAt, updated_at as updatedAt,
                  last_github_sync_at as lastGithubSyncAt,
                spawned_from_session_id as spawnedFromSessionId,
                spawned_from_task_id as spawnedFromTaskId,
                spawned_fingerprint as spawnedFingerprint,
                spawned_from_board_ref as spawnedFromBoardRef,
                spawned_order as spawnedOrder
           FROM sessions WHERE id = ?`
      )
      .get(id) as (Omit<SessionSummary, "dangerouslySkipPermissions"> & { dangerouslySkipPermissions?: number | null }) | undefined;
    if (!session) return null;
    const normalizedSession: SessionSummary = {
      ...session,
      dangerouslySkipPermissions:
        session.dangerouslySkipPermissions == null ? undefined : Boolean(session.dangerouslySkipPermissions)
    };

    const detail = {
      session: normalizedSession,
      runs: this.db
        .prepare(
          `SELECT id, session_id as sessionId, side, role, provider,
                  native_session_id as nativeSessionId, native_session_name as nativeSessionName,
                  resume_command as resumeCommand, resume_args_json as resumeArgsJson,
                  status, started_at as startedAt, ended_at as endedAt, exit_code as exitCode
             FROM agent_runs WHERE session_id = ? ORDER BY started_at DESC`
        )
        .all(id)
        .map((row: unknown) => {
          const typed = row as AgentRunSummary & { resumeArgsJson?: string };
          return {
            ...typed,
            resumeArgs: JSON.parse(typed.resumeArgsJson || "[]") as string[]
          };
        }) as AgentRunSummary[],
      transcript: this.db
        .prepare(
          `SELECT *
             FROM (
               SELECT id, session_id as sessionId, run_id as runId, side, type, content, created_at as createdAt
                 FROM transcript_events
                WHERE session_id = ?
                ORDER BY created_at DESC
                LIMIT 200
             )
            ORDER BY createdAt ASC`
        )
        .all(id) as TranscriptEvent[],
      evidence: this.db
        .prepare(
          `SELECT id, session_id as sessionId, key, title, status, source, ref, updated_at as updatedAt
             FROM evidence_items WHERE session_id = ? ORDER BY rowid ASC`
        )
        .all(id) as EvidenceItem[],
      evidenceRecords: this.listEvidenceRecords(id),
      workflowEvents: this.db
        .prepare(
          `SELECT id, session_id as sessionId, action, actor_type as actorType, actor_role as actorRole,
                  phase_from as phaseFrom, phase_to as phaseTo, result,
                  user_approved as userApproved, created_at as createdAt
             FROM workflow_events WHERE session_id = ? ORDER BY created_at DESC LIMIT 100`
        )
        .all(id) as WorkflowEvent[],
      deployAttempts: this.listDeployAttempts(id),
      handoffs: this.db
        .prepare(
          `SELECT id, session_id as sessionId, from_side as fromSide, from_role as fromRole,
                  to_side as toSide, to_role as toRole, round_n as roundN, round_total as roundTotal,
                  summary, evidence_json as evidenceJson, status, created_at as createdAt, approved_at as approvedAt
             FROM handoffs WHERE session_id = ? ORDER BY created_at DESC`
        )
        .all(id)
        .map((row: unknown) => {
          const typed = row as HandoffRow;
          return { ...typed, evidence: JSON.parse(typed.evidenceJson || "[]") } as Handoff;
        }),
      outputCards: this.listOutputCards(id),
      github: this.getGithubCache(id),
      board: this.getBoardArtifact(id),
      conductor: this.getConductorState(id),
      usageSummary: this.usageSummary(id)
    };
    detail.session.agentRunCount = detail.runs.length;
    return detail;
  }

  addOutputCard(input: NativeOutputCardInput): NativeOutputCard {
    const card: NativeOutputCard = {
      ...input,
      id: randomUUID(),
      createdAt: input.createdAt ?? new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO native_output_cards (id, session_id, side, kind, title, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(card.id, card.sessionId, card.side, card.kind, card.title, card.body, card.createdAt);
    return card;
  }

  updateConductorState(
    sessionId: string,
    patch: Partial<Omit<ConductorSnapshot, "sessionId" | "updatedAt">>
  ): SessionDetail {
    const existing = this.getConductorState(sessionId);
    const next: ConductorSnapshot = {
      sessionId,
      automationLevel: patch.automationLevel ?? existing?.automationLevel ?? "manual",
      currentStepId: patch.currentStepId ?? existing?.currentStepId,
      activeSide: patch.activeSide ?? existing?.activeSide,
      restorePending: patch.restorePending ?? existing?.restorePending ?? false,
      chosenImplementerSide: patch.chosenImplementerSide ?? existing?.chosenImplementerSide,
      chosenImplementerProvider: patch.chosenImplementerProvider ?? existing?.chosenImplementerProvider,
      ideaRound: patch.ideaRound ?? existing?.ideaRound ?? 1,
      technicalRound: patch.technicalRound ?? existing?.technicalRound ?? 1,
      codeRound: patch.codeRound ?? existing?.codeRound ?? 1,
      updatedAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO conductor_state
         (session_id, automation_level, current_step_id, active_side, restore_pending,
          chosen_implementer_side, chosen_implementer_provider,
          idea_round, technical_round, code_round, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           automation_level = excluded.automation_level,
           current_step_id = excluded.current_step_id,
           active_side = excluded.active_side,
           restore_pending = excluded.restore_pending,
           chosen_implementer_side = excluded.chosen_implementer_side,
           chosen_implementer_provider = excluded.chosen_implementer_provider,
           idea_round = excluded.idea_round,
           technical_round = excluded.technical_round,
           code_round = excluded.code_round,
           updated_at = excluded.updated_at`
      )
      .run(
        sessionId,
        next.automationLevel,
        next.currentStepId ?? null,
        next.activeSide ?? null,
        next.restorePending ? 1 : 0,
        next.chosenImplementerSide ?? null,
        next.chosenImplementerProvider ?? null,
        next.ideaRound,
        next.technicalRound,
        next.codeRound,
        next.updatedAt
      );
    // Only log a workflow event when the step actually changes. Routine patches (activeSide /
    // restorePending fire on every send/start) were flooding workflow_events — the fastest-growing
    // table, loaded in full by getSession.
    if (next.currentStepId !== existing?.currentStepId) {
      this.addWorkflowEvent(sessionId, "conductor.state_updated", "app", "ok", existing?.currentStepId, next.currentStepId, false);
    }
    return this.getSession(sessionId)!;
  }

  saveGithubCache(sessionId: string, issue: GitHubIssueContext, workspace?: WorkspaceConfig): void {
    const ideaType = inferIdeaType({ title: issue.title, labels: issue.labels });
    this.db
      .prepare(
        `INSERT INTO github_artifact_cache
         (session_id, repo, issue_number, title, body, url, status, labels_json, fields_json, comments_head_json, linked_prs_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           repo = excluded.repo,
           issue_number = excluded.issue_number,
           title = excluded.title,
           body = excluded.body,
           url = excluded.url,
           status = excluded.status,
           labels_json = excluded.labels_json,
           fields_json = excluded.fields_json,
           comments_head_json = excluded.comments_head_json,
           linked_prs_json = excluded.linked_prs_json,
           fetched_at = excluded.fetched_at`
      )
      .run(
        sessionId,
        issue.repo,
        issue.issueNumber,
        issue.title,
        issue.body,
        issue.url,
        // NEVER substitute the issue state (OPEN/CLOSED) for a missing Project status — downstream
        // logic ("does this card have a board status yet?") must see the absence.
        issue.projectStatus ?? null,
        JSON.stringify(issue.labels),
        JSON.stringify(issue.projectFields ?? {}),
        JSON.stringify(issue.comments.slice(-8)),
        JSON.stringify(issue.linkedPrs ?? []),
        issue.fetchedAt
      );

    const mapped = issue.projectStatus ? mapProjectStatus(issue.projectStatus, workspace) : null;
    if (mapped) {
      this.db
        .prepare(
          `UPDATE sessions
              SET title = ?, idea_type = COALESCE(idea_type, ?), visible_phase = ?, internal_state = ?, status = ?,
                  last_github_sync_at = ?, updated_at = ?
            WHERE id = ?`
        )
        .run(issue.title, ideaType, mapped.visiblePhase, mapped.internalState, mapped.sessionStatus, issue.fetchedAt, issue.fetchedAt, sessionId);
    } else {
      this.db
        .prepare(`UPDATE sessions SET title = ?, idea_type = COALESCE(idea_type, ?), last_github_sync_at = ?, updated_at = ? WHERE id = ?`)
        .run(issue.title, ideaType, issue.fetchedAt, issue.fetchedAt, sessionId);
    }
    this.updateEvidence(sessionId, "issue_linked", "done", "github", issue.url);
  }

  linkGithubIssue(sessionId: string, issue: GitHubIssueContext, workspace?: WorkspaceConfig): void {
    const [owner, repo] = issue.repo.split("/");
    if (!owner || !repo) throw new Error(`Invalid repository: ${issue.repo}`);
    const now = new Date().toISOString();
    const inTaskReview = issue.labels.includes("needs-task-review");
    const mapped = issue.projectStatus ? mapProjectStatus(issue.projectStatus, workspace) : null;
    const ideaType = inferIdeaType({ title: issue.title, labels: issue.labels });
    this.db
      .prepare(
        `UPDATE sessions
            SET title = ?,
                idea_type = COALESCE(idea_type, ?),
                artifact_type = 'issue',
                repo_owner = ?,
                repo_name = ?,
                issue_number = ?,
                board_provider = 'github_project',
                board_item_id = ?,
                board_item_key = ?,
                board_item_url = ?,
                visible_phase = ?,
                internal_state = ?,
                updated_at = ?
          WHERE id = ?`
      )
      .run(
        issue.title,
        ideaType,
        owner,
        repo,
        issue.issueNumber,
        issue.projectFields?.ProjectItemId ?? null,
        `${issue.repo}#${issue.issueNumber}`,
        issue.url,
        mapped?.visiblePhase ?? (inTaskReview ? "review" : "define"),
        mapped?.internalState ?? (inTaskReview ? "review.definition" : "define.drafting"),
        now,
        sessionId
      );
    this.addWorkflowEvent(sessionId, "github.issue_attached", "human", "ok", undefined, inTaskReview ? "review" : "define", true);
    this.addTranscript(sessionId, "workflow", `Attached GitHub issue ${issue.repo}#${issue.issueNumber}`);
    this.recordWorkflowEvidence(
      sessionId,
      "board_transition",
      `Board task attached: ${issue.repo}#${issue.issueNumber}`,
      `GitHub issue "${issue.title}" was attached as the board artifact for this session.`,
      { source: "board", boardUrl: issue.url }
    );
  }

  linkBoardDraft(sessionId: string, draft: { id: string; key?: string; title: string; body?: string; url?: string; status?: string }, workspace?: WorkspaceConfig): void {
    const now = new Date().toISOString();
    const mapped = draft.status ? mapProjectStatus(draft.status, workspace) : null;
    this.db
      .prepare(
        `UPDATE sessions
            SET title = ?,
                artifact_type = 'issue',
                board_provider = 'github_project',
                board_item_id = ?,
                board_item_key = ?,
                board_item_url = ?,
                visible_phase = ?,
                internal_state = ?,
                status = ?,
                updated_at = ?
          WHERE id = ?`
      )
      .run(
        draft.title,
        draft.id,
        draft.key ?? draft.id,
        draft.url ?? null,
        mapped?.visiblePhase ?? "capture",
        mapped?.internalState ?? "capture.materializing",
        mapped?.sessionStatus ?? "waiting",
        now,
        sessionId
      );
    this.updateEvidence(sessionId, "issue_linked", "done", "github", draft.url ?? draft.id);
    this.addWorkflowEvent(sessionId, "board.draft_attached", "app", "ok", undefined, mapped?.visiblePhase ?? "capture", true);
    this.addTranscript(sessionId, "workflow", `Attached board draft ${draft.key ?? draft.id}`);
    this.recordWorkflowEvidence(
      sessionId,
      "board_transition",
      `Board draft attached: ${draft.key ?? draft.id}`,
      `Board draft "${draft.title}" was attached as the board artifact for this session.`,
      { source: "board", boardUrl: draft.url }
    );
  }

  linkBoardItem(
    sessionId: string,
    item: { provider: string; id: string; key?: string; title: string; body?: string; url?: string; status?: string },
    workspace?: WorkspaceConfig
  ): void {
    const now = new Date().toISOString();
    const mapped = item.status ? mapProjectStatus(item.status, workspace) : null;
    this.db
      .prepare(
        `UPDATE sessions
            SET title = ?,
                artifact_type = 'issue',
                board_provider = ?,
                board_item_id = ?,
                board_item_key = ?,
                board_item_url = ?,
                visible_phase = ?,
                internal_state = ?,
                status = ?,
                updated_at = ?
          WHERE id = ?`
      )
      .run(
        item.title,
        item.provider,
        item.id,
        item.key ?? item.id,
        item.url ?? null,
        mapped?.visiblePhase ?? "capture",
        mapped?.internalState ?? "capture.materializing",
        mapped?.sessionStatus ?? "waiting",
        now,
        sessionId
      );
    this.updateEvidence(sessionId, "issue_linked", "done", item.provider, item.url ?? item.key ?? item.id);
    this.addWorkflowEvent(sessionId, "board.item_attached", "app", "ok", undefined, mapped?.visiblePhase ?? "capture", true);
    this.addTranscript(sessionId, "workflow", `Attached ${item.provider} board item ${item.key ?? item.id}`);
    this.recordWorkflowEvidence(
      sessionId,
      "board_transition",
      `Board task attached: ${item.key ?? item.id}`,
      `${item.provider} item "${item.title}" was attached as the board artifact for this session.`,
      { source: "board", boardUrl: item.url }
    );
  }

  createSession(input: CreateSessionInput): SessionDetail {
    const now = new Date().toISOString();
    const id = randomUUID();
    const [owner, repo] = input.repo?.split("/") ?? [null, null];
    const visiblePhase = input.artifactType === "idea" ? "capture" : "define";
    const internalState = input.artifactType === "idea" ? "capture.from_idea" : "define.drafting";

    this.db
      .prepare(
        `INSERT INTO sessions
         (id, title, initial_body, artifact_type, repo_owner, repo_name, issue_number, pr_number,
          board_provider, board_item_id, board_item_key, board_item_url, branch_name,
          idea_type, workspace_name, left_role, left_provider, right_role, right_provider,
          dangerously_skip_permissions,
          visible_phase, internal_state, status, round_n, round_total, created_at, updated_at,
          spawned_from_session_id, spawned_from_task_id, spawned_fingerprint, spawned_from_board_ref, spawned_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.issueBody?.trim() || null,
        input.artifactType,
        owner,
        repo,
        input.issueNumber ?? null,
        input.prNumber ?? null,
        input.boardProvider ?? (input.repo && input.issueNumber ? "github_project" : null),
        input.boardItemId ?? null,
        input.boardItemKey ?? (input.repo && input.issueNumber ? `${input.repo}#${input.issueNumber}` : null),
        input.boardItemUrl ?? null,
        input.branchName ?? null,
        inferIdeaType({ explicit: input.ideaType, title: input.title, quickNoteKind: input.quickNoteKind }),
        input.workspaceName ?? null,
        input.leftRole ?? null,
        input.leftProvider ?? null,
        input.rightRole ?? null,
        input.rightProvider ?? null,
        input.dangerouslySkipPermissions ? 1 : 0,
        visiblePhase,
        internalState,
        "waiting",
        input.roundTotal ?? 3,
        now,
        now,
        input.spawnedFromSessionId ?? null,
        input.spawnedFromTaskId ?? null,
        input.spawnedFingerprint ?? null,
        input.spawnedFromBoardRef ?? null,
        input.spawnedOrder ?? null
      );

    this.seedEvidence(id, input.artifactType === "issue" ? ["issue_linked"] : []);
    this.addTranscript(id, "system", `Session created for ${input.artifactType}: ${input.title}`);
    this.addWorkflowEvent(id, "session.created", "human", "ok", undefined, visiblePhase, true);
    this.updateConductorState(id, { automationLevel: input.automationLevel ?? "auto" });
    // session.created itself is audit-only; a brief record exists only when there is real content.
    const briefBody = input.issueBody?.trim();
    if (briefBody) {
      this.recordWorkflowEvidence(id, "brief", `Brief: ${input.title}`, briefBody, { source: "human" });
    }
    return this.getSession(id)!;
  }

  // Persist the task body locally. For Jira sessions we don't cache the live issue body (getBoardArtifact
  // returns body: "" for Jira), so the agent brief falls back to initial_body. When Agent 1's corrected
  // plan is pushed to the Jira issue, mirror it here so the reviewer reads the current plan, not the seed.
  setSessionBody(sessionId: string, body: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET initial_body = ?, updated_at = ? WHERE id = ?`)
      .run(body.trim() || null, now, sessionId);
  }

  updateSession(input: UpdateSessionInput): SessionDetail {
    const title = input.title.trim();
    if (!title) throw new Error("Session title is required.");
    const now = new Date().toISOString();
    const ideaType = inferIdeaType({ explicit: input.ideaType, title });
    this.db
      .prepare(`UPDATE sessions SET title = ?, initial_body = ?, idea_type = ?, updated_at = ? WHERE id = ?`)
      .run(title, input.initialBody?.trim() || null, ideaType, now, input.id);
    this.addWorkflowEvent(input.id, "session.updated", "human", "ok", undefined, undefined, true);
    this.addTranscript(input.id, "workflow", "Session details updated");
    const detail = this.getSession(input.id);
    if (!detail) throw new Error("Session not found");
    return detail;
  }

  deleteSession(id: string): void {
    const transaction = this.db.transaction(() => this.deleteSessionRows(id));
    transaction();
  }

  // Delete every session belonging to a workspace (used by Delete Project) in one transaction.
  deleteSessionsForWorkspace(workspaceName: string, defaultWorkspaceName?: string): number {
    const rows = this.db
      .prepare(`SELECT id, workspace_name as workspaceName FROM sessions`)
      .all() as Array<{ id: string; workspaceName: string | null }>;
    const ids = rows
      .filter((row) => (row.workspaceName ?? defaultWorkspaceName) === workspaceName)
      .map((row) => row.id);
    if (ids.length === 0) return 0;
    const transaction = this.db.transaction(() => {
      for (const id of ids) this.deleteSessionRows(id);
    });
    transaction();
    return ids.length;
  }

  private deleteSessionRows(id: string): void {
    const tables = [
      "agent_runs",
      "transcript_events",
      "native_output_cards",
      "composer_messages",
      "handoffs",
      "evidence_items",
      "evidence_records",
      "workflow_events",
      "deploy_attempts",
      "github_artifact_cache",
      "conductor_state",
      "usage_events"
    ];
    for (const table of tables) {
      this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
    }
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  addComposerMessage(input: ComposerMessageInput): TranscriptEvent {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO composer_messages (id, session_id, target, mode, text, context_json, mute_other, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.sessionId, input.target, "instruction", input.text, "{}", input.muteOther ? 1 : 0, now);
    return this.addTranscript(input.sessionId, "user", input.text, input.target);
  }

  createHandoffDraft(
    sessionId: string,
    fromSide: "L" | "R",
    fromRole: string,
    toSide: "L" | "R",
    toRole: string
  ): Handoff {
    const detail = this.getSession(sessionId);
    if (!detail) throw new Error("Session not found");
    const now = new Date().toISOString();
    const id = randomUUID();
    const summary = this.buildHandoffSummary(detail, fromRole, toRole);
    const evidence = detail.evidence
      .filter((item) => item.status === "done")
      .map((item) => ({ key: item.key, label: item.title, ref: item.ref }));

    this.db
      .prepare(
        `INSERT INTO handoffs
         (id, session_id, from_side, from_role, to_side, to_role, round_n, round_total,
          summary, evidence_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`
      )
      .run(
        id,
        sessionId,
        fromSide,
        fromRole,
        toSide,
        toRole,
        detail.session.roundN,
        detail.session.roundTotal,
        summary,
        JSON.stringify(evidence),
        now
      );

    this.addTranscript(sessionId, "handoff", summary);
    return this.getSession(sessionId)!.handoffs[0];
  }

  approveHandoff(id: string): Handoff | null {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE handoffs SET status = 'sent', approved_at = ? WHERE id = ?`).run(now, id);
    const row = this.db
      .prepare(
        `SELECT id, session_id as sessionId, from_side as fromSide, from_role as fromRole,
                to_side as toSide, to_role as toRole, round_n as roundN, round_total as roundTotal,
                summary, evidence_json as evidenceJson, status, created_at as createdAt, approved_at as approvedAt
           FROM handoffs WHERE id = ?`
      )
      .get(id) as (Omit<Handoff, "evidence"> & { evidenceJson: string }) | undefined;
    if (!row) return null;
    this.addWorkflowEvent(row.sessionId, "handoff.approved", "human", "ok", undefined, undefined, true);
    return { ...row, evidence: JSON.parse(row.evidenceJson || "[]") };
  }

  getHandoff(id: string): Handoff | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id as sessionId, from_side as fromSide, from_role as fromRole,
                to_side as toSide, to_role as toRole, round_n as roundN, round_total as roundTotal,
                summary, evidence_json as evidenceJson, status, created_at as createdAt, approved_at as approvedAt
           FROM handoffs WHERE id = ?`
      )
      .get(id) as (Omit<Handoff, "evidence"> & { evidenceJson: string }) | undefined;
    return row ? { ...row, evidence: JSON.parse(row.evidenceJson || "[]") } : null;
  }

  startAgentRun(
    id: string,
    sessionId: string,
    side: "L" | "R",
    role: string,
    provider: string,
    command: string,
    cwd: string,
    nativeSessionId?: string,
    nativeSessionName?: string,
    resumeCommand?: string,
    resumeArgs: string[] = []
  ): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs
         (id, session_id, side, role, provider, command, cwd, native_session_id, native_session_name,
          resume_command, resume_args_json, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`
      )
      .run(
        id,
        sessionId,
        side,
        role,
        provider,
        command,
        cwd,
        nativeSessionId ?? null,
        nativeSessionName ?? null,
        resumeCommand ?? null,
        JSON.stringify(resumeArgs),
        new Date().toISOString()
      );
    this.updateConductorState(sessionId, { activeSide: side, restorePending: false });
    this.addWorkflowEvent(sessionId, `agent.${side}.started`, "app", "ok", undefined, undefined, false);
  }

  finishAgentRun(id: string, sessionId: string, side: "L" | "R", exitCode: number): void {
    this.db
      .prepare(
        `UPDATE agent_runs
            SET status = CASE WHEN status = 'interrupted' THEN status ELSE 'exited' END,
                ended_at = ?, exit_code = ?
          WHERE id = ?`
      )
      .run(new Date().toISOString(), exitCode, id);
    this.addWorkflowEvent(sessionId, `agent.${side}.exited`, "app", exitCode === 0 ? "ok" : "failed", undefined, undefined, false);
  }

  clearAgentResume(sessionId: string, side: "L" | "R"): SessionDetail {
    this.db
      .prepare(
        `UPDATE agent_runs
            SET native_session_id = NULL,
                native_session_name = NULL,
                resume_command = NULL,
                resume_args_json = '[]'
          WHERE session_id = ?
            AND side = ?`
      )
      .run(sessionId, side);
    this.addWorkflowEvent(sessionId, `agent.${side}.resume_cleared`, "app", "warned", undefined, undefined, false);
    this.addSystemTranscript(sessionId, `Cleared saved resume id for side ${side}`, side);
    const detail = this.getSession(sessionId);
    if (!detail) throw new Error("Session not found");
    return detail;
  }

  markRunningAgentRunsInterrupted(): void {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(`SELECT DISTINCT session_id as sessionId FROM agent_runs WHERE status = 'running'`)
      .all() as Array<{ sessionId: string }>;
    this.db
      .prepare(`UPDATE agent_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'`)
      .run(now);
    for (const row of rows) {
      this.updateConductorState(row.sessionId, { restorePending: true });
      this.addWorkflowEvent(row.sessionId, "agent_runs.interrupted", "app", "warned", undefined, undefined, false);
    }
  }

  startDeployAttempt(sessionId: string, command: string, args: string[]): DeployAttempt {
    const attempt: DeployAttempt = {
      id: randomUUID(),
      sessionId,
      status: "running",
      command,
      args,
      startedAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO deploy_attempts (id, session_id, status, command, args_json, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(attempt.id, sessionId, attempt.status, command, JSON.stringify(args), attempt.startedAt);
    this.addWorkflowEvent(sessionId, "deploy.attempt.started", "app", "ok", undefined, undefined, true);
    return attempt;
  }

  finishDeployAttempt(id: string, status: Extract<DeployAttempt["status"], "succeeded" | "failed">, output?: string, error?: string): void {
    const sessionRow = this.db
      .prepare(`SELECT session_id as sessionId FROM deploy_attempts WHERE id = ?`)
      .get(id) as { sessionId: string } | undefined;
    this.db
      .prepare(`UPDATE deploy_attempts SET status = ?, output = ?, error = ?, ended_at = ? WHERE id = ?`)
      .run(status, output ?? null, error ?? null, new Date().toISOString(), id);
    if (sessionRow) {
      this.addWorkflowEvent(
        sessionRow.sessionId,
        status === "succeeded" ? "deploy.attempt.succeeded" : "deploy.attempt.failed",
        "app",
        status === "succeeded" ? "ok" : "failed",
        undefined,
        undefined,
        true
      );
      // Per the dual-write table, only the deploy FINISH becomes evidence (start is audit-only).
      const attemptRow = this.db
        .prepare(`SELECT command FROM deploy_attempts WHERE id = ?`)
        .get(id) as { command?: string } | undefined;
      this.recordWorkflowEvidence(
        sessionRow.sessionId,
        "deploy",
        status === "succeeded" ? "Deploy succeeded" : "Deploy failed",
        status === "succeeded"
          ? `The deploy command "${attemptRow?.command ?? "unknown"}" completed successfully. Full output is on the deploy attempt record.`
          : `The deploy command "${attemptRow?.command ?? "unknown"}" failed: ${compactText(error ?? "no error captured", 400)}`,
        { source: "app", rawRef: `deploy_attempt:${id}` }
      );
    }
  }

  addPtyTranscript(sessionId: string, side: "L" | "R", content: string): void {
    const trimmed = content.trim();
    if (!trimmed) return;
    // PTY output is live terminal display, not durable evidence. Persist only a compact tail so
    // sessions.get doesn't hydrate megabytes of TUI redraws and repeated banners.
    const capped = trimmed.length > 2400 ? `${trimmed.slice(-2400).trimStart()}\n[Earlier terminal redraw omitted by Twindem.]` : trimmed;
    this.addTranscript(sessionId, "pty", capped, side);
  }

  addSystemTranscript(sessionId: string, content: string, side?: "L" | "R"): void {
    this.addTranscript(sessionId, "system", content, side);
  }

  recordTaskReview(sessionId: string, verdict: "ok" | "changes" | "blocked"): SessionDetail {
    const detail = this.getSession(sessionId);
    if (!detail) throw new Error("Session not found");
    const now = new Date().toISOString();
    const maxRoundsReached = verdict === "changes" && detail.session.roundN >= detail.session.roundTotal;
    const phaseTo = verdict === "ok" ? "execute" : verdict === "blocked" || maxRoundsReached ? "review" : "define";
    const internalState =
      verdict === "ok" ? "queue.ready" : verdict === "blocked" || maxRoundsReached ? "blocked" : "define.drafting";
    const status = verdict === "blocked" || maxRoundsReached ? "blocked" : "waiting";
    const nextRound = verdict === "changes" && !maxRoundsReached ? detail.session.roundN + 1 : detail.session.roundN;

    this.db
      .prepare(
        `UPDATE sessions SET visible_phase = ?, internal_state = ?, status = ?, round_n = ?, updated_at = ? WHERE id = ?`
      )
      .run(phaseTo, internalState, status, nextRound, now, sessionId);

    if (verdict === "ok") {
      this.updateEvidence(sessionId, "task_review_ok", "done", "github", "review-done");
    }

    this.addWorkflowEvent(
      sessionId,
      maxRoundsReached ? "task_review.max_rounds_reached" : `task_review.${verdict}`,
      maxRoundsReached ? "app" : "human",
      verdict === "blocked" || maxRoundsReached ? "blocked" : "ok",
      detail.session.visiblePhase,
      phaseTo,
      true
    );
    this.addTranscript(
      sessionId,
      "workflow",
      maxRoundsReached
        ? `Max review rounds reached (${detail.session.roundN}/${detail.session.roundTotal}). Human decision required.`
        : `Task review verdict recorded: ${verdict}`
    );
    this.recordWorkflowEvidence(
      sessionId,
      "review",
      maxRoundsReached ? "Review loop reached max rounds" : `Review verdict: ${verdict}`,
      maxRoundsReached
        ? `Review round ${detail.session.roundN}/${detail.session.roundTotal} returned "changes" and hit the round limit — the loop paused for a human decision.`
        : `Task review verdict "${verdict}" recorded in round ${detail.session.roundN}/${detail.session.roundTotal}.`,
      { source: maxRoundsReached ? "app" : "human", phase: detail.session.visiblePhase }
    );
    return this.getSession(sessionId)!;
  }

  markTaskReviewRequested(sessionId: string): SessionDetail {
    const detail = this.getSession(sessionId);
    if (!detail) throw new Error("Session not found");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions SET visible_phase = 'review', internal_state = 'review.definition',
                status = 'waiting', updated_at = ? WHERE id = ?`
      )
      .run(now, sessionId);
    this.addWorkflowEvent(sessionId, "task_review.requested", "human", "ok", detail.session.visiblePhase, "review", true);
    this.addTranscript(sessionId, "workflow", "Task review requested");
    this.recordWorkflowEvidence(
      sessionId,
      "review",
      "Task review requested",
      "The human requested a task-definition review; the task moved to the review phase.",
      { source: "human", phase: "review" }
    );
    return this.getSession(sessionId)!;
  }

  transitionSession(
    sessionId: string,
    target: "uat" | "done",
    internalState: string,
    projectStatus: string
  ): SessionDetail {
    const detail = this.getSession(sessionId);
    if (!detail) throw new Error("Session not found");
    const visiblePhase = target === "uat" ? "verify" : "done";
    const status = target === "done" ? "done" : "waiting";
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET visible_phase = ?, internal_state = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(visiblePhase, internalState, status, now, sessionId);
    this.addWorkflowEvent(sessionId, `workflow.${target}`, "human", "ok", detail.session.visiblePhase, visiblePhase, true);
    this.addTranscript(sessionId, "workflow", `Workflow moved to ${projectStatus}`);
    this.recordWorkflowEvidence(
      sessionId,
      target === "done" ? "decision" : "approval",
      target === "done" ? `Task closed: moved to ${projectStatus}` : `Approved for ${projectStatus}`,
      target === "done"
        ? `The human moved the task to "${projectStatus}" — the work is accepted as complete.`
        : `The human approved the work and moved the task to "${projectStatus}" for validation.`,
      { source: "human", phase: visiblePhase }
    );
    return this.getSession(sessionId)!;
  }

  updateEvidence(
    sessionId: string,
    key: string,
    status: string,
    source?: string,
    ref?: string
  ): void {
    this.db
      .prepare(
        `UPDATE evidence_items SET status = ?, source = ?, ref = ?, updated_at = ?
          WHERE session_id = ? AND key = ?`
      )
      .run(status, source ?? null, ref ?? null, new Date().toISOString(), sessionId, key);
  }

  setEvidenceStatus(sessionId: string, key: string, status: EvidenceStatus, ref?: string): SessionDetail {
    const detail = this.getSession(sessionId);
    if (!detail) throw new Error("Session not found");
    this.updateEvidence(sessionId, key, status, "manual", ref);
    this.addWorkflowEvent(sessionId, `evidence.${key}.${status}`, "human", status === "blocked" ? "blocked" : "ok", undefined, undefined, true);
    this.addTranscript(sessionId, "workflow", `Evidence ${key} marked ${status}`);
    // Manual gate changes are human approval-type decisions; app-driven updateEvidence stays audit-only.
    this.recordWorkflowEvidence(
      sessionId,
      status === "done" ? "approval" : "note",
      `Gate "${evidenceTitles[key] ?? key}" marked ${status}`,
      `The human manually set the "${evidenceTitles[key] ?? key}" checklist gate to ${status}${ref ? ` (${ref})` : ""}.`,
      { source: "human", rawRef: ref }
    );
    return this.getSession(sessionId)!;
  }

  // `slot` is the explicit target for Twindem-initiated moves: the slot is the source of truth, so we
  // persist its phase directly instead of re-deriving it from the status name (which is ambiguous when
  // two slots write the same status, e.g. uat and in_progress both → "In Progress"). When omitted
  // (external sync from a raw board status), fall back to deriving the slot from the status name.
  updateBoardStatus(
    sessionId: string,
    projectStatus: string,
    workspace?: WorkspaceConfig,
    slot?: BoardStatusSlot
  ): SessionDetail {
    const mapped = slot ? sessionStateForSlot(slot) : mapProjectStatus(projectStatus, workspace);
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET visible_phase = ?, internal_state = ?, status = ?, board_status = ?, updated_at = ? WHERE id = ?`)
      .run(mapped.visiblePhase, mapped.internalState, mapped.sessionStatus, projectStatus, now, sessionId);
    this.db
      .prepare(`UPDATE github_artifact_cache SET status = ?, fetched_at = ? WHERE session_id = ?`)
      .run(projectStatus, now, sessionId);
    this.addWorkflowEvent(sessionId, "github.project_status.updated", "app", "ok", undefined, mapped.visiblePhase, true);
    this.addTranscript(sessionId, "workflow", `Project status changed to ${projectStatus}`);
    // Explicit status moves are decisions; routine board syncs (saveGithubCache) stay audit-only.
    this.recordWorkflowEvidence(
      sessionId,
      "board_transition",
      `Board status → ${projectStatus}`,
      `The board status was changed to "${projectStatus}" (phase: ${mapped.visiblePhase}).`,
      { source: "board", phase: mapped.visiblePhase }
    );
    return this.getSession(sessionId)!;
  }

  addWorkflowEvent(
    sessionId: string,
    action: string,
    actorType: WorkflowEvent["actorType"],
    result: WorkflowEvent["result"],
    phaseFrom?: string,
    phaseTo?: string,
    userApproved = false
  ): void {
    this.db
      .prepare(
        `INSERT INTO workflow_events
         (id, session_id, action, actor_type, phase_from, phase_to, result, user_approved, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        sessionId,
        action,
        actorType,
        phaseFrom ?? null,
        phaseTo ?? null,
        result,
        userApproved ? 1 : 0,
        new Date().toISOString()
      );
  }

  addEvidenceRecord(input: EvidenceRecordInput): EvidenceRecord {
    const now = new Date().toISOString();
    const workspaceName =
      input.workspaceName ??
      (this.db.prepare(`SELECT workspace_name as workspaceName FROM sessions WHERE id = ?`).get(input.sessionId) as
        | { workspaceName?: string }
        | undefined)?.workspaceName ??
      undefined;
    const record: EvidenceRecord = {
      ...input,
      workspaceName,
      summary: capEvidenceSummary(input.summary),
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `INSERT INTO evidence_records
         (id, session_id, workspace_name, phase, kind, title, summary, details_json, source, agent_side,
          raw_ref, raw_path, board_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.sessionId,
        record.workspaceName ?? null,
        record.phase,
        record.kind,
        record.title,
        record.summary,
        record.details ? JSON.stringify(record.details) : null,
        record.source ?? null,
        record.agentSide ?? null,
        record.rawRef ?? null,
        record.rawPath ?? null,
        record.boardUrl ?? null,
        record.createdAt,
        record.updatedAt
      );
    return record;
  }

  listEvidenceRecords(sessionId: string): EvidenceRecord[] {
    return this.db
      .prepare(
        `SELECT id, session_id as sessionId, workspace_name as workspaceName, phase, kind, title, summary,
                details_json as detailsJson, source, agent_side as agentSide, raw_ref as rawRef,
                raw_path as rawPath, board_url as boardUrl, created_at as createdAt, updated_at as updatedAt
           FROM evidence_records
          WHERE session_id = ?
          ORDER BY created_at ASC
          LIMIT 200`
      )
      .all(sessionId)
      .map((row: unknown) => {
        const typed = row as EvidenceRecordRow;
        const { detailsJson, ...rest } = typed;
        return {
          ...rest,
          details: detailsJson ? (JSON.parse(detailsJson) as Record<string, unknown>) : undefined
        } as EvidenceRecord;
      });
  }

  // Convenience writer for the automatic recording points: fills phase from the session row.
  recordWorkflowEvidence(
    sessionId: string,
    kind: EvidenceRecordKind,
    title: string,
    summary: string,
    options?: Partial<EvidenceRecordInput>
  ): EvidenceRecord {
    const session = this.db
      .prepare(`SELECT visible_phase as visiblePhase FROM sessions WHERE id = ?`)
      .get(sessionId) as { visiblePhase?: string } | undefined;
    return this.addEvidenceRecord({
      sessionId,
      phase: options?.phase ?? session?.visiblePhase ?? "capture",
      kind,
      title,
      summary,
      ...options,
      source: options?.source ?? "app"
    });
  }

  // One usage row per agent run: the row id IS the run id, so the main process can accumulate
  // estimates in memory and write absolute totals with a throttled upsert — never a row per PTY
  // flush. Standalone events (no active run) get a random id via addStandaloneUsageEvent.
  upsertRunUsage(input: {
    runId: string;
    sessionId: string;
    side: AgentSide;
    phase?: string;
    provider?: string;
    model?: string;
    inputEstimateTokens: number;
    outputEstimateTokens: number;
    startedAt?: string;
    endedAt?: string;
  }): void {
    const now = new Date().toISOString();
    const workspaceName = this.sessionWorkspaceName(input.sessionId);
    this.db
      .prepare(
        `INSERT INTO usage_events
         (id, session_id, workspace_name, run_id, agent_side, phase, provider, model, mode,
          input_estimate_tokens, output_estimate_tokens, source, started_at, ended_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'tui_estimate', ?, ?, 'pty', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           input_estimate_tokens = excluded.input_estimate_tokens,
           output_estimate_tokens = excluded.output_estimate_tokens,
           ended_at = COALESCE(excluded.ended_at, usage_events.ended_at)`
      )
      .run(
        input.runId,
        input.sessionId,
        workspaceName ?? null,
        input.runId,
        input.side,
        input.phase ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.inputEstimateTokens,
        input.outputEstimateTokens,
        input.startedAt ?? now,
        input.endedAt ?? null,
        now
      );
  }

  addStandaloneUsageEvent(input: {
    sessionId: string;
    side?: AgentSide;
    phase?: string;
    inputEstimateTokens?: number;
    outputEstimateTokens?: number;
    source: UsageEvent["source"];
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO usage_events
         (id, session_id, workspace_name, agent_side, phase, mode, input_estimate_tokens,
          output_estimate_tokens, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'tui_estimate', ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.sessionId,
        this.sessionWorkspaceName(input.sessionId) ?? null,
        input.side ?? null,
        input.phase ?? null,
        input.inputEstimateTokens ?? 0,
        input.outputEstimateTokens ?? 0,
        input.source,
        now
      );
  }

  listUsageEvents(sessionId: string): UsageEvent[] {
    return this.db
      .prepare(
        `SELECT id, session_id as sessionId, workspace_name as workspaceName, run_id as runId,
                agent_side as agentSide, phase, provider, model, mode,
                input_estimate_tokens as inputEstimateTokens, output_estimate_tokens as outputEstimateTokens,
                input_tokens as inputTokens, output_tokens as outputTokens, cached_tokens as cachedTokens,
                reasoning_tokens as reasoningTokens, estimated_cost_usd as estimatedCostUsd,
                actual_cost_usd as actualCostUsd, source, started_at as startedAt, ended_at as endedAt,
                created_at as createdAt
           FROM usage_events
          WHERE session_id = ?
          ORDER BY created_at ASC`
      )
      .all(sessionId) as UsageEvent[];
  }

  usageSummary(sessionId: string): UsageSummary | undefined {
    const rows = this.db
      .prepare(
        `SELECT agent_side as side, provider, model, COALESCE(phase, 'unknown') as phase,
                SUM(input_estimate_tokens) as input, SUM(output_estimate_tokens) as output
           FROM usage_events
          WHERE session_id = ?
          GROUP BY agent_side, provider, model, COALESCE(phase, 'unknown')`
      )
      .all(sessionId) as UsageSummaryRow[];
    return usageSummaryFromRows(rows);
  }

  workspaceUsageSummary(workspaceName: string): UsageSummary | undefined {
    const rows = this.db
      .prepare(
        `SELECT usage_events.agent_side as side, usage_events.provider, usage_events.model,
                COALESCE(usage_events.phase, 'unknown') as phase,
                SUM(usage_events.input_estimate_tokens) as input,
                SUM(usage_events.output_estimate_tokens) as output
           FROM usage_events
           LEFT JOIN sessions ON sessions.id = usage_events.session_id
          WHERE COALESCE(usage_events.workspace_name, sessions.workspace_name) = ?
          GROUP BY usage_events.agent_side, usage_events.provider, usage_events.model, COALESCE(usage_events.phase, 'unknown')`
      )
      .all(workspaceName) as UsageSummaryRow[];
    return usageSummaryFromRows(rows);
  }

  private sessionWorkspaceName(sessionId: string): string | undefined {
    return (
      this.db.prepare(`SELECT workspace_name as workspaceName FROM sessions WHERE id = ?`).get(sessionId) as
        | { workspaceName?: string }
        | undefined
    )?.workspaceName;
  }

  private seedEvidence(sessionId: string, doneKeys: string[]): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO evidence_items (id, session_id, key, title, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const [key, title] of Object.entries(evidenceTitles)) {
      insert.run(randomUUID(), sessionId, key, title, doneKeys.includes(key) ? "done" : "pending", now);
    }
  }

  private buildHandoffSummary(detail: SessionDetail, fromRole: string, toRole: string): string {
    const issueRef = detail.session.repo && detail.session.issueNumber
      ? `${detail.session.repo}#${detail.session.issueNumber}`
      : detail.session.boardItemKey ?? detail.session.boardItemId ?? detail.session.title;
    const github = detail.github;
    const board = detail.board;
    const taskBody = board?.body?.trim() || github?.body.trim() || detail.session.initialBody?.trim();
    const taskComments = (board?.comments ?? github?.comments)?.slice(-4).map((comment) =>
      `- ${comment.author}: ${compactText(comment.body, 360)}${comment.url ? ` (${comment.url})` : ""}`
    );
    const doneEvidence = detail.evidence.filter((item) => item.status === "done");
    const blockedEvidence = detail.evidence.filter((item) => item.status === "blocked");
    const latestWorkflow = detail.workflowEvents.slice(0, 5).map((event) => `${event.action}: ${event.result}`);
    const lastResultCard = detail.outputCards
      .filter((card) => card.kind === "result" || card.kind === "verdict")
      .slice(-1)[0];
    const latestTranscript = detail.transcript
      .filter((event) => event.type === "user" || event.type === "workflow" || event.type === "handoff")
      .slice(-4)
      .map((event) => `- ${event.type}${event.side ? ` ${event.side}` : ""}: ${compactText(event.content, 260)}`);

    return [
      `From: ${fromRole}`,
      `To: ${toRole}`,
      "",
      "Task:",
      `${toRole} must review the task definition and return exactly one verdict: OK, Changes requested, or Blocked.`,
      "Focus on the board task definition, acceptance criteria, scope, risks, board state, and missing evidence. Do not start implementation unless the verdict is OK and you are explicitly asked to execute.",
      "",
      `Review target: ${issueRef}`,
      ...(board?.url || github?.url ? [`URL: ${board?.url ?? github?.url}`] : []),
      ...(board?.title || github?.title ? [`Task title: ${board?.title ?? github?.title}`] : []),
      ...(board?.status || github?.projectStatus || github?.state ? [`Board status: ${board?.status ?? github?.projectStatus ?? github?.state}`] : []),
      ...((board?.labels ?? github?.labels ?? []).length ? [`Labels: ${(board?.labels ?? github?.labels ?? []).join(", ")}`] : []),
      `Phase: ${detail.session.visiblePhase} (${detail.session.internalState})`,
      `Round: ${detail.session.roundN}/${detail.session.roundTotal}`,
      "",
      "Task body excerpt:",
      taskBody ? compactText(taskBody, 2200) : "- No board task body is attached to this session.",
      "",
      "Recent board comments:",
      ...(taskComments && taskComments.length > 0 ? taskComments : ["- None"]),
      "",
      "Summary:",
      `Continue review/work on ${detail.session.title}. Use the evidence and recent activity below before taking action.`,
      "",
      "Done evidence:",
      ...(doneEvidence.length > 0 ? doneEvidence.map((item) => `- ${item.title}${item.ref ? ` (${item.ref})` : ""}`) : ["- None yet"]),
      "",
      "Blocked evidence:",
      ...(blockedEvidence.length > 0 ? blockedEvidence.map((item) => `- ${item.title}`) : ["- None"]),
      "",
      "Recent workflow:",
      ...(latestWorkflow.length > 0 ? latestWorkflow.map((item) => `- ${item}`) : ["- No workflow events yet"]),
      "",
      ...(lastResultCard ? [
        "Last agent result:",
        `- ${lastResultCard.title}: ${compactText(lastResultCard.body, 500)}`,
        ""
      ] : []),
      "Recent context:",
      ...(latestTranscript.length > 0 ? latestTranscript : ["- No recent transcript context"]),
      "",
      `Ask: ${toRole} should review the current state, identify required corrections or evidence, and return one clear verdict.`,
      'When done, finish with: TWINDEM_RESULT: {"verdict":"OK|Changes requested|Blocked","summary":"...","nextAction":"..."}'
    ].join("\n");
  }

  private addTranscript(
    sessionId: string,
    type: TranscriptEvent["type"],
    content: string,
    side?: string
  ): TranscriptEvent {
    const event: TranscriptEvent = {
      id: randomUUID(),
      sessionId,
      type,
      content,
      side: side === "L" || side === "R" ? side : undefined,
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO transcript_events (id, session_id, side, type, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(event.id, sessionId, event.side ?? null, type, content, event.createdAt);
    return event;
  }

  private getConductorState(sessionId: string): ConductorSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id as sessionId, automation_level as automationLevel,
                current_step_id as currentStepId,
                active_side as activeSide, restore_pending as restorePending,
                chosen_implementer_side as chosenImplementerSide,
                chosen_implementer_provider as chosenImplementerProvider,
                idea_round as ideaRound, technical_round as technicalRound,
                code_round as codeRound, updated_at as updatedAt
           FROM conductor_state WHERE session_id = ?`
      )
      .get(sessionId) as ConductorSnapshot | undefined;
    return row ? { ...row, restorePending: Boolean(row.restorePending) } : undefined;
  }

  private listOutputCards(sessionId: string): NativeOutputCard[] {
    return this.db
      .prepare(
        `SELECT id, session_id as sessionId, side, kind, title, body, created_at as createdAt
           FROM native_output_cards
          WHERE session_id = ?
          ORDER BY created_at ASC
          LIMIT 200`
      )
      .all(sessionId) as NativeOutputCard[];
  }

  private listDeployAttempts(sessionId: string): DeployAttempt[] {
    return this.db
      .prepare(
        `SELECT id, session_id as sessionId, status, command, args_json as argsJson,
                output, error, started_at as startedAt, ended_at as endedAt
           FROM deploy_attempts
          WHERE session_id = ?
          ORDER BY started_at DESC
          LIMIT 20`
      )
      .all(sessionId)
      .map((row: unknown) => {
        const typed = row as DeployAttemptRow;
        return {
          ...typed,
          args: JSON.parse(typed.argsJson || "[]") as string[]
        };
      });
  }

  private getGithubCache(sessionId: string): GitHubIssueContext | undefined {
    const row = this.db
      .prepare(
        `SELECT repo, issue_number as issueNumber, title, body, url, status, labels_json as labelsJson,
                fields_json as fieldsJson, comments_head_json as commentsJson, linked_prs_json as linkedPrsJson,
                fetched_at as fetchedAt
           FROM github_artifact_cache WHERE session_id = ?`
      )
      .get(sessionId) as
      | {
          repo: string;
          issueNumber: number;
          title?: string;
          body?: string;
          url?: string;
	          status?: string;
	          labelsJson?: string;
	          fieldsJson?: string;
	          commentsJson?: string;
          linkedPrsJson?: string;
          fetchedAt: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      repo: row.repo,
      issueNumber: row.issueNumber,
      title: row.title ?? "",
      body: row.body ?? "",
      state: row.status ?? "",
      url: row.url ?? "",
      projectStatus: row.status,
      projectFields: JSON.parse(row.fieldsJson || "{}") as Record<string, string>,
      labels: JSON.parse(row.labelsJson || "[]") as string[],
      comments: JSON.parse(row.commentsJson || "[]") as GitHubIssueContext["comments"],
      linkedPrs: JSON.parse(row.linkedPrsJson || "[]") as GitHubIssueContext["linkedPrs"],
      fetchedAt: row.fetchedAt
    };
  }

  private getBoardArtifact(sessionId: string): BoardArtifact | undefined {
    const session = this.db
      .prepare(
        `SELECT board_provider as boardProvider, board_item_id as boardItemId,
                board_item_key as boardItemKey, board_item_url as boardItemUrl,
                board_status as boardStatus, visible_phase as visiblePhase
           FROM sessions WHERE id = ?`
      )
      .get(sessionId) as
      | {
          boardProvider?: string;
          boardItemId?: string;
          boardItemKey?: string;
          boardItemUrl?: string;
          boardStatus?: string;
          visiblePhase?: string;
        }
      | undefined;
    const github = this.getGithubCache(sessionId);
    if (github) {
      return {
        provider: session?.boardProvider ?? "github_project",
        kind: "github_issue",
        id: session?.boardItemId ?? `${github.repo}#${github.issueNumber}`,
        key: session?.boardItemKey ?? `${github.repo}#${github.issueNumber}`,
        title: github.title,
        body: github.body,
        state: github.state,
        url: session?.boardItemUrl ?? github.url,
        labels: github.labels,
        comments: github.comments,
        linkedPrs: github.linkedPrs,
        status: github.projectStatus,
        fields: github.projectFields,
        fetchedAt: github.fetchedAt,
        github: {
          repo: github.repo,
          issueNumber: github.issueNumber
        }
      };
    }
    if (!session?.boardProvider || !session.boardItemId) return undefined;
    return {
      provider: session.boardProvider,
      kind: session.boardProvider === "jira" ? "jira_issue" : "board_item",
      id: session.boardItemId,
      key: session.boardItemKey ?? session.boardItemId,
      title: "",
      body: "",
      // Persisted per-session board status (Jira / GitHub drafts that have no github cache row). If a
      // task moved status before this column existed, fall back to a status derived from the local
      // phase so catch-up knows the task already has a status instead of asking A1 to propose one.
      status: session.boardStatus ?? boardStatusFromVisiblePhase(session.visiblePhase),
      url: session.boardItemUrl,
      labels: [],
      comments: [],
      fetchedAt: new Date().toISOString()
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        initial_body TEXT,
        artifact_type TEXT NOT NULL,
        idea_type TEXT,
        repo_owner TEXT,
        repo_name TEXT,
        issue_number INTEGER,
        board_provider TEXT,
        board_item_id TEXT,
        board_item_key TEXT,
        board_item_url TEXT,
        pr_number INTEGER,
        branch_name TEXT,
        visible_phase TEXT NOT NULL,
        internal_state TEXT NOT NULL,
        status TEXT NOT NULL,
        round_n INTEGER DEFAULT 1,
        round_total INTEGER DEFAULT 3,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_github_sync_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        side TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT,
        native_session_id TEXT,
        native_session_name TEXT,
        resume_command TEXT,
        resume_args_json TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        exit_code INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS transcript_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        side TEXT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS native_output_cards (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        side TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS composer_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        target TEXT NOT NULL,
        mode TEXT NOT NULL,
        text TEXT NOT NULL,
        context_json TEXT,
        mute_other INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        from_run_id TEXT,
        from_side TEXT,
        from_role TEXT NOT NULL,
        to_side TEXT,
        to_role TEXT NOT NULL,
        round_n INTEGER NOT NULL,
        round_total INTEGER NOT NULL,
        summary TEXT NOT NULL,
        evidence_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS evidence_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT,
        ref TEXT,
        metadata_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_name TEXT,
        phase TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT,
        source TEXT,
        agent_side TEXT,
        raw_ref TEXT,
        raw_path TEXT,
        board_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_records_session_created
      ON evidence_records(session_id, created_at);

      CREATE TABLE IF NOT EXISTS workflow_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_role TEXT,
        phase_from TEXT,
        phase_to TEXT,
        result TEXT NOT NULL,
        user_approved INTEGER DEFAULT 0,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_name TEXT,
        run_id TEXT,
        agent_side TEXT,
        phase TEXT,
        provider TEXT,
        model TEXT,
        mode TEXT NOT NULL,
        input_estimate_tokens INTEGER DEFAULT 0,
        output_estimate_tokens INTEGER DEFAULT 0,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_tokens INTEGER,
        reasoning_tokens INTEGER,
        estimated_cost_usd REAL,
        actual_cost_usd REAL,
        source TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_events_session_created
      ON usage_events(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_usage_events_workspace_created
      ON usage_events(workspace_name, created_at);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_run
      ON usage_events(run_id) WHERE run_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS deploy_attempts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE TABLE IF NOT EXISTS github_artifact_cache (
        session_id TEXT PRIMARY KEY,
        repo TEXT,
        issue_number INTEGER,
        pr_number INTEGER,
        project_item_id TEXT,
        title TEXT,
        body TEXT,
        url TEXT,
        status TEXT,
        labels_json TEXT,
        fields_json TEXT,
        comments_head_json TEXT,
        linked_prs_json TEXT,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conductor_state (
        session_id TEXT PRIMARY KEY,
        automation_level TEXT NOT NULL DEFAULT 'manual',
        current_step_id TEXT,
        active_side TEXT,
        restore_pending INTEGER DEFAULT 0,
        chosen_implementer_side TEXT,
        chosen_implementer_provider TEXT,
        idea_round INTEGER NOT NULL DEFAULT 1,
        technical_round INTEGER NOT NULL DEFAULT 1,
        code_round INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureColumn("sessions", "workspace_name", "TEXT");
    this.ensureColumn("sessions", "idea_type", "TEXT");
    this.ensureColumn("sessions", "initial_body", "TEXT");
    this.ensureColumn("sessions", "board_provider", "TEXT");
    this.ensureColumn("sessions", "board_item_id", "TEXT");
    this.ensureColumn("sessions", "board_item_key", "TEXT");
    this.ensureColumn("sessions", "board_item_url", "TEXT");
    this.ensureColumn("sessions", "board_status", "TEXT");
    this.db
      .prepare(
        `UPDATE sessions
            SET board_provider = COALESCE(board_provider, 'github_project'),
                board_item_key = COALESCE(board_item_key, repo_owner || '/' || repo_name || '#' || issue_number)
          WHERE issue_number IS NOT NULL
            AND repo_owner IS NOT NULL
            AND repo_name IS NOT NULL`
      )
      .run();
    this.ensureColumn("sessions", "left_role", "TEXT");
    this.ensureColumn("sessions", "left_provider", "TEXT");
    this.ensureColumn("sessions", "right_role", "TEXT");
    this.ensureColumn("sessions", "right_provider", "TEXT");
    this.ensureColumn("sessions", "dangerously_skip_permissions", "INTEGER");
    this.ensureColumn("sessions", "hidden", "INTEGER DEFAULT 0");
    this.ensureColumn("sessions", "spawned_from_session_id", "TEXT");
    this.ensureColumn("sessions", "spawned_from_task_id", "TEXT");
    this.ensureColumn("sessions", "spawned_fingerprint", "TEXT");
    this.ensureColumn("sessions", "spawned_from_board_ref", "TEXT");
    this.ensureColumn("sessions", "spawned_order", "INTEGER");
    this.ensureColumn("agent_runs", "native_session_id", "TEXT");
    this.ensureColumn("agent_runs", "native_session_name", "TEXT");
    this.ensureColumn("agent_runs", "resume_command", "TEXT");
    this.ensureColumn("agent_runs", "resume_args_json", "TEXT");
    this.ensureColumn("composer_messages", "mute_other", "INTEGER DEFAULT 0");
    this.ensureColumn("github_artifact_cache", "title", "TEXT");
    this.ensureColumn("github_artifact_cache", "body", "TEXT");
    this.ensureColumn("github_artifact_cache", "url", "TEXT");
    this.ensureColumn("github_artifact_cache", "linked_prs_json", "TEXT");
    this.ensureColumn("conductor_state", "active_side", "TEXT");
    this.ensureColumn("conductor_state", "restore_pending", "INTEGER DEFAULT 0");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    assertSqlIdentifier(table);
    assertSqlIdentifier(column);
    assertColumnDefinition(definition);
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

function assertSqlIdentifier(value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
}

function assertColumnDefinition(value: string): void {
  if (!/^[A-Z0-9_ ()]+$/i.test(value)) {
    throw new Error(`Unsafe SQL column definition: ${value}`);
  }
}

// Generic status name from the local phase, used only as a fallback when no real board status was
// persisted yet. capture → undefined on purpose (Inbox/no-status is the one place we WANT to let an
// agent propose a status). The exact name is approximate; a real status move overwrites it.
function boardStatusFromVisiblePhase(visiblePhase?: string): string | undefined {
  switch (visiblePhase) {
    case "define":
      return "Planning";
    case "review":
      return "Review";
    case "execute":
      return "In Progress";
    case "verify":
      return "UAT";
    case "done":
      return "Done";
    default:
      return undefined;
  }
}

function compactText(value: string, maxLength: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function capEvidenceSummary(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= EVIDENCE_SUMMARY_MAX) return trimmed;
  return `${trimmed.slice(0, EVIDENCE_SUMMARY_MAX - 14).trimEnd()}… [truncated]`;
}
