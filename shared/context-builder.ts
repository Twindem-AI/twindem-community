// Single governed context layer for both agents. Pure over SessionDetail + WorkspaceConfig (no
// Electron imports) so the renderer imports it directly and the main process can reuse it later —
// there is intentionally NO context.getPack IPC; two parallel paths to the same pack are forbidden.
//
// renderAgentContextBrief MUST be deterministic: identical pack → byte-identical text (no
// timestamps, stable section/list order). Agent CLIs cache stable prompt prefixes; nondeterminism
// here silently busts that cache on every message.
import type {
  AgentContextPack,
  AgentSide,
  EvidenceRecord,
  IdeaType,
  InstructionMode,
  PhasePolicy,
  RawContextRef,
  SessionDetail,
  VisiblePhase
} from "./domain.js";
import type { TandemConfig } from "./config.js";
import { resolveAllowedRoots } from "./config.js";
import { ideaTypeDefinition, type IdeaPhaseKey } from "./idea-types.js";

export type WorkspaceConfig = TandemConfig["workspaces"][number];

// Canonical mapping between the two existing phase vocabularies and the default instruction kind.
// InstructionMode is NOT a phase: "orientation" is also used whenever an agent is (re)started or
// switched mid-task, and "corrections" marks round N+1 of a review loop in any phase.
const PHASE_TO_IDEA_PHASE: Record<VisiblePhase, IdeaPhaseKey> = {
  capture: "planning",
  define: "planning",
  execute: "in_progress",
  review: "review",
  verify: "uat",
  done: "done"
};

const PHASE_TO_DEFAULT_MODE: Record<VisiblePhase, InstructionMode> = {
  capture: "orientation",
  define: "plan",
  execute: "work",
  review: "review",
  verify: "approval",
  done: "done"
};

export function ideaPhaseKeyForVisiblePhase(phase: VisiblePhase): IdeaPhaseKey {
  return PHASE_TO_IDEA_PHASE[phase] ?? "planning";
}

export function defaultInstructionModeForPhase(phase: VisiblePhase): InstructionMode {
  return PHASE_TO_DEFAULT_MODE[phase] ?? "orientation";
}

export function phasePolicyForIdeaType(input: {
  ideaType?: IdeaType;
  phase: VisiblePhase;
  mode: InstructionMode;
}): PhasePolicy {
  const type = ideaTypeDefinition(input.ideaType);
  const ideaPhase = ideaPhaseKeyForVisiblePhase(input.phase);
  // Orientation is a READ-ONLY turn regardless of phase: it states where the task stands, it never
  // authorizes work. Only a real work instruction (plan/work/corrections) may enable implementation.
  const isOrientation = input.mode === "orientation";
  const implementsNow = !isOrientation && type.requiresImplementation && ideaPhase === "in_progress";

  const allowedActions = [
    "read code, docs, and the inlined board content inside the workspace root",
    "ask the user clarifying questions and WAIT for answers"
  ];
  const disallowedActions = [
    "inspect, plan, edit, branch, or open PRs in repositories outside the workspace root",
    "create or modify board items, labels, milestones, or project membership — Twindem and the human handle board bookkeeping"
  ];
  if (isOrientation) {
    disallowedActions.push(
      "write or change any production code, post a verdict, or move the board — this orientation turn is read-only; wait for the work instruction"
    );
  } else if (type.requiresImplementation) {
    if (implementsNow) {
      allowedActions.push(`implement the approved plan on a dedicated task branch (In Progress means: ${type.phases.in_progress})`);
    } else {
      disallowedActions.push(
        `write or change production code — for a ${type.label} task, implementation happens only in the In Progress phase`
      );
    }
  } else {
    allowedActions.push(`produce the ${type.artifact} work product (In Progress means: ${type.phases.in_progress})`);
    disallowedActions.push(
      "write or change production code — code changes require explicit human approval of a spike or proof of concept"
    );
  }

  const quality = type.quality;
  const qualityRules = [
    ...(quality.preserve.length ? [`Preserve in every summary, handoff, and compaction: ${quality.preserve.join(", ")}.`] : []),
    ...(quality.compact.length ? [`Compact only: ${quality.compact.join(", ")}.`] : []),
    "Report test/check results as counts plus full failures only — never paste passing-test output."
  ];

  return {
    requiresImplementation: implementsNow,
    requiredArtifact: ideaPhase === "planning" ? `plan for the ${type.artifact}` : type.artifact,
    allowedActions,
    disallowedActions,
    qualityRules,
    requiredSections: quality.requiredSections
  };
}

// Concise quality block for the phase-specific prompt builders (analysis/review/implement), so
// policy text is written once here instead of being duplicated per prompt.
export function qualityRuleLines(ideaType?: string | null): string[] {
  const quality = ideaTypeDefinition(ideaType).quality;
  const lines = [
    ...(quality.preserve.length ? [`- Preserve: ${quality.preserve.join(", ")}.`] : []),
    ...(quality.compact.length ? [`- Compact only: ${quality.compact.join(", ")}.`] : []),
    ...(quality.requiredSections.length ? [`- Required artifact sections: ${quality.requiredSections.join("; ")}.`] : [])
  ];
  return lines.length ? ["Quality rules:", ...lines] : [];
}

export function buildAgentContextPack(input: {
  detail: SessionDetail;
  workspace?: WorkspaceConfig;
  side: AgentSide;
  mode: InstructionMode;
}): AgentContextPack {
  const { detail, workspace, side, mode } = input;
  const session = detail.session;
  const type = ideaTypeDefinition(session.ideaType);
  const phase = (session.visiblePhase || "capture") as VisiblePhase;
  const policy = phasePolicyForIdeaType({ ideaType: type.key, phase, mode });

  const boardRef =
    session.repo && session.issueNumber
      ? `${session.repo}#${session.issueNumber}`
      : session.boardItemKey ?? session.boardItemId ?? undefined;
  const boardUrl = detail.board?.url ?? detail.github?.url ?? session.boardItemUrl ?? undefined;
  const body = detail.board?.body?.trim() || detail.github?.body?.trim() || session.initialBody?.trim() || undefined;

  const rawRefs: RawContextRef[] = [];
  if (boardUrl) rawRefs.push({ label: "Board artifact", kind: "board", url: boardUrl });
  rawRefs.push({
    label: "Latest shaped task body (kept by Agent 1)",
    kind: "file",
    path: `.twindem/ideas/${session.id}.md`
  });

  return {
    sessionId: session.id,
    side,
    mode,
    workspaceName: workspace?.name,
    workspaceRoot: workspace?.root?.trim() || undefined,
    boardProvider: detail.board?.provider ?? session.boardProvider,
    boardArtifact: detail.board,
    boardRef,
    boardUrl,
    title: detail.board?.title || detail.github?.title || session.title,
    body,
    ideaType: type.key,
    phase,
    statusSlot: (detail.board?.status ?? detail.github?.projectStatus)?.trim() || undefined,
    requiresImplementation: type.requiresImplementation,
    requiredArtifact: policy.requiredArtifact,
    allowedActions: policy.allowedActions,
    disallowedActions: policy.disallowedActions,
    qualityRules: policy.qualityRules,
    projectDescription: workspace?.description?.trim() || undefined,
    projectInstructions: workspace?.agentInstructions?.trim() || undefined,
    allowedRoots: resolveAllowedRoots(workspace),
    evidenceSummary: detail.evidenceRecords.slice(-12),
    rawRefs
  };
}

function workspaceGuardrailLines(pack: AgentContextPack): string[] {
  if (!pack.workspaceRoot && !pack.projectDescription && !pack.projectInstructions) return [];
  return [
    "",
    "Project context:",
    ...(pack.workspaceName ? ["Workspace:", pack.workspaceName] : []),
    ...(pack.workspaceRoot
      ? [
          "Workspace root / implementation boundary:",
          pack.workspaceRoot,
          "You are already running inside this workspace root. The board artifact's repository may be a tracking repository only — do NOT treat the issue repo as the implementation repo.",
          ...(pack.allowedRoots && pack.allowedRoots.length > 0
            ? [
                `Editable code roots (create/edit code ONLY inside these): ${pack.allowedRoots.join(", ")}`,
                "If a change fits no listed root, put it in the principal repo at the project root and say so. Never create code outside the editable roots."
              ]
            : ["Do NOT edit or open PRs in sibling/external repositories outside this workspace root unless the user explicitly authorizes it."])
        ]
      : []),
    ...(pack.projectDescription ? ["Description:", pack.projectDescription] : []),
    ...(pack.projectInstructions ? ["Standing agent instructions:", pack.projectInstructions] : [])
  ];
}

function governanceLines(pack: AgentContextPack): string[] {
  const type = ideaTypeDefinition(pack.ideaType);
  return [
    "",
    "Task governance:",
    `- Idea type: ${type.label}. Required artifact: ${pack.requiredArtifact}.`,
    `- Requires implementation by default: ${pack.requiresImplementation ? "yes" : "no"}.`,
    "- Allowed now:",
    ...pack.allowedActions.map((action) => `  - ${action}`),
    "- Not allowed:",
    ...pack.disallowedActions.map((action) => `  - ${action}`),
    ...(pack.qualityRules.length ? ["- Quality rules:", ...pack.qualityRules.map((rule) => `  - ${rule}`)] : [])
  ];
}

function evidenceSummaryLines(records: EvidenceRecord[]): string[] {
  if (records.length === 0) return [];
  // Newest 6, oldest first — timestamps intentionally omitted (determinism + brevity).
  const recent = records.slice(-6);
  return [
    "",
    "Recent task evidence (Twindem records):",
    ...recent.map((record) => `- [${record.kind}] ${record.title}: ${compactLine(record.summary, 200)}`)
  ];
}

function compactLine(value: string, maxLength: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

// Evidence kinds that survive a restart: the durable decision trail. Chatter (notes, board
// transitions) is dropped — quality `preserve` lists guarantee decisions/constraints/alternatives
// live in these records, so the handoff never needs transcript replay.
const RESTART_HANDOFF_KINDS = new Set<EvidenceRecord["kind"]>([
  "brief",
  "plan",
  "artifact",
  "review",
  "decision",
  "approval",
  "risk",
  "follow_up",
  "deploy"
]);

// "Restart with compact handoff": a long-lived CLI session re-sends its whole history every turn,
// so per-message cost grows continuously. This brief re-seeds a FRESH agent from the orientation
// pack + the preserve-filtered evidence trail instead of the bloated conversation.
export function renderCompactRestartHandoff(pack: AgentContextPack, records: EvidenceRecord[]): string {
  const preserved = records.filter((record) => RESTART_HANDOFF_KINDS.has(record.kind)).slice(-20);
  const latestFindings = [...records]
    .reverse()
    .map((record) => (Array.isArray(record.details?.findings) ? (record.details?.findings as Array<Record<string, unknown>>) : null))
    .find((findings) => findings && findings.length > 0);
  // Role-scoped: the author (A1) only needs findings still OPEN (work to do); the reviewer (A2)
  // only needs the ones A1 marked ADDRESSED (work to verify). Replaying addressed findings to A1
  // would make it redo finished work; replaying open ones to A2 has nothing to verify yet.
  const sideFindings = (latestFindings ?? []).filter((finding) =>
    pack.side === "L" ? finding.status === "open" : finding.status === "addressed"
  );
  const findingsHeader =
    pack.side === "L"
      ? "Review findings still to address (by id):"
      : "Findings Agent 1 addressed — verify ONLY these (by id):";
  return [
    "Twindem — restart with compact handoff. Your previous session was restarted to keep context compact; the durable state below REPLACES the old conversation (there is no transcript replay).",
    "",
    // The preserve-filtered trail below is the single evidence section of the handoff — render
    // the orientation without its own (unfiltered) evidence summary so chatter can't leak in.
    renderAgentContextBrief({ ...pack, evidenceSummary: [] }),
    ...(preserved.length > 0
      ? [
          "",
          "Preserved decision trail (oldest first):",
          ...preserved.map((record) => `- [${record.kind}] ${record.title}: ${compactLine(record.summary, 300)}`)
        ]
      : []),
    ...(sideFindings.length > 0
      ? [
          "",
          findingsHeader,
          ...sideFindings.map(
            (finding) => `- ${String(finding.id)} [${String(finding.severity)}] ${String(finding.title)}`
          )
        ]
      : []),
    "",
    "Continue from this state — do not redo completed work, and do not re-derive decisions already recorded above."
  ].join("\n");
}

// Orientation brief. It only ORIENTS (read the inlined context, summarize, WAIT) — it never asks
// for a marker; the real work instruction with its signal-file protocol arrives next. These
// closing protocol lines are load-bearing for the signal scraping in the main process: keep them.
export function renderAgentContextBrief(pack: AgentContextPack): string {
  const role = pack.side === "L" ? "Agent 1 (Author / Implementer)" : "Agent 2 (Reviewer)";

  if (!pack.boardRef) {
    // Local idea (no board issue yet) — rehydrates a freshly-switched DIFFERENT CLI from the
    // durable context (the idea body file A1 keeps + the original seed).
    if (!pack.body) return "";
    return [
      `Twindem — you are ${role}, continuing an in-progress idea discussion (the agent was just switched, so you have no prior memory of it).`,
      ...workspaceGuardrailLines(pack),
      ...governanceLines(pack),
      `If the file \`.twindem/ideas/${pack.sessionId}.md\` exists, READ IT FIRST — it holds the latest shaped analysis.`,
      "Original idea / seed from the user:",
      pack.body,
      ...evidenceSummaryLines(pack.evidenceSummary),
      "Briefly confirm you're caught up (one or two lines), then WAIT for the user to continue. Do NOT restart the analysis from scratch and do not emit any marker."
    ].join("\n");
  }

  const status = pack.boardArtifact?.status?.trim() || pack.statusSlot || pack.phase;
  const provider = pack.boardProvider ?? "github_project";
  const isAuthor = pack.side === "L";

  // Both agents get the recent comment trail: it's the single source of truth for the review loop
  // (A2 posts each review as a comment; A1 replies "updated per comment #N"). The reviewer MUST see
  // its own prior findings + A1's reply, otherwise it can't tell what changed and re-flags the same
  // issue verbatim. A1 also needs them to know which findings it already addressed.
  const comments = (pack.boardArtifact?.comments ?? []).slice(-6).map(
    (comment) => `- ${comment.author}: ${compactLine(comment.body, 360)}`
  );

  const contentPolicy =
    provider === "jira"
      ? [
          "This task came from Jira. The task content above, synced by Twindem, is the source of truth for now. Do NOT use gh for this task. If Jira body/comments are needed but not present here, ask the human for the missing context and WAIT."
        ]
      : [
          pack.body
            ? "The task body above is Twindem's synced copy of the board task — do NOT re-read the task or its comments unless something specific is missing; fetch only the missing piece if the provider/tooling allows it, or ask the human and WAIT."
            : "Use gh to read the issue body and recent comments once, then stop fetching — do not re-read content you already have."
        ];

  return [
    `Twindem — you are ${role} on an existing board task.`,
    `Task: ${pack.title}`,
    `Board artifact: ${pack.boardRef}`,
    `URL: ${pack.boardUrl ?? ""}`,
    ...workspaceGuardrailLines(pack),
    ...governanceLines(pack),
    `Current board status: ${status}.`,
    ...(pack.body ? ["Task body / description (synced by Twindem):", pack.body] : []),
    ...(comments.length ? ["Recent comments (newest last):", ...comments] : []),
    ...contentPolicy,
    ...(isAuthor ? evidenceSummaryLines(pack.evidenceSummary) : []),
    isAuthor
      ? "Summarize where the task stands and what the next step would be, then WAIT — Twindem will send your work instruction (refine / implement / corrections) when the human chooses."
      : 'Summarize what there is to review: the task body/plan above (kept current by Agent 1) and the recent comment trail, which is the single source of truth for this review loop — your prior findings and Agent 1\'s "updated per review" replies live there. Then WAIT — Twindem will send your review instruction when the human clicks "Review → A2".',
    "Do NOT change code or post a verdict yet, and do not emit any marker — the work instruction with its exact protocol arrives next."
  ].join("\n");
}
