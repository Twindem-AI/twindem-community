import { z } from "zod";
import { IDEA_TYPE_DEFINITIONS } from "./idea-types.js";

export const ProviderSchema = z.object({
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  resumeCommand: z.string().optional(),
  resumeArgs: z.array(z.string()).default([]),
  model: z.string().optional(),
  version: z.string().optional(),
  authMode: z.enum(["none", "subscription", "api_key"]).optional(),
  apiKeyEnv: z.string().optional(),
  apiKeySecretRef: z.string().optional(),
  supportsResume: z.boolean().default(false)
});

export const RoleSchema = z.object({
  description: z.string(),
  allowedActions: z.array(z.string())
});

export const WorkflowSchema = z.object({
  visiblePhases: z.array(z.string()),
  roundLimit: z.number().int().positive().default(3),
  projectStatusField: z.string(),
  statusMap: z.record(z.string(), z.string()),
  gates: z.record(z.string(), z.array(z.string())).default({}),
  labels: z.object({
    taskReviewRequested: z.string(),
    taskReviewOk: z.string(),
    taskReviewChanges: z.string()
  }),
  instructionTemplates: z.record(z.string(), z.string()).default({}),
  evidenceKeys: z.array(z.string()),
  guardrails: z.object({
    hard: z.array(z.string()),
    soft: z.array(z.string())
  })
});

export const IdeaTypeSchema = z.enum(["feature", "bug", "spike", "architecture", "research", "runbook"]);

export const IdeaTypeDefinitionSchema = z.object({
  key: IdeaTypeSchema,
  label: z.string(),
  artifact: z.string(),
  requiresImplementation: z.boolean(),
  summary: z.string(),
  labelName: z.string(),
  phases: z.object({
    planning: z.string(),
    in_progress: z.string(),
    review: z.string(),
    uat: z.string(),
    done: z.string()
  }),
  evidence: z.string(),
  quality: z
    .object({
      preserve: z.array(z.string()).default([]),
      compact: z.array(z.string()).default([]),
      requiredSections: z.array(z.string()).default([]),
      doneEvidence: z.array(z.string()).default([])
    })
    .default({ preserve: [], compact: [], requiredSections: [], doneEvidence: [] })
});

export const BoardStatusSlotSchema = z.enum([
  "inbox",
  "planning",
  "ready",
  "todo",
  "in_progress",
  "review",
  "uat",
  "release_ready",
  "done",
  "blocked",
  "wont_do"
]);

export type BoardStatusSlot = z.infer<typeof BoardStatusSlotSchema>;

export const defaultWorkspaceStatusMapping = {
  read: {
    Inbox: "inbox",
    Backlog: "inbox",
    Triage: "inbox",
    Planning: "planning",
    "Selected for Development": "planning",
    Refinement: "planning",
    Ready: "ready",
    Todo: "todo",
    "To Do": "todo",
    "In Progress": "in_progress",
    "In Review": "review",
    Review: "review",
    UAT: "uat",
    Testing: "uat",
    QA: "uat",
    Staging: "uat",
    "Release Ready": "release_ready",
    Done: "done",
    Complete: "done",
    Completed: "done",
    Blocked: "blocked",
    "Wont Do": "wont_do",
    "Won't Do": "wont_do",
    Canceled: "wont_do",
    Cancelled: "wont_do",
    Bug: "inbox"
  },
  write: {
    inbox: "Inbox",
    planning: "Planning",
    ready: "Ready",
    todo: "Todo",
    in_progress: "In Progress",
    review: "Review",
    uat: "UAT",
    release_ready: "Release Ready",
    done: "Done",
    blocked: "Blocked",
    wont_do: "Wont Do"
  },
  ignored: [] as string[]
} satisfies {
  read: Record<string, BoardStatusSlot>;
  write: Partial<Record<BoardStatusSlot, string>>;
  ignored: string[];
};

export const WorkspaceStatusMappingSchema = z.object({
  read: z.record(z.string(), BoardStatusSlotSchema).default(defaultWorkspaceStatusMapping.read),
  write: z
    .object({
      inbox: z.string().optional(),
      planning: z.string().optional(),
      ready: z.string().optional(),
      todo: z.string().optional(),
      in_progress: z.string().optional(),
      review: z.string().optional(),
      uat: z.string().optional(),
      release_ready: z.string().optional(),
      done: z.string().optional(),
      blocked: z.string().optional(),
      wont_do: z.string().optional()
    })
    .default(defaultWorkspaceStatusMapping.write),
  // Real board statuses the user explicitly chose to leave outside the Twindem workflow. `read` is a
  // status→slot map and cannot express "known but ignored", so this list carries that intent. Ignored
  // statuses resolve to no slot before any default-alias fallback applies.
  ignored: z.array(z.string()).default([])
});

export const PaneDefaultSchema = z.object({
  role: z.string(),
  roles: z.array(z.string()).optional(),
  provider: z.string()
});

export const WorkspaceSchema = z.object({
  name: z.string(),
  root: z.string(),
  boardProvider: z.enum(["github_project", "jira", "none"]).optional(),
  githubOwner: z.string().optional(),
  projectNumber: z.number().int().positive().optional(),
  issueRepository: z.string().optional(),
  jiraSiteUrl: z.string().optional(),
  jiraProjectKey: z.string().optional(),
  jiraBoardId: z.string().optional(),
  jiraIssueType: z.string().optional(),
  jiraEmail: z.string().optional(),
  jiraApiTokenSecretRef: z.string().optional(),
  allowedRepoPaths: z.array(z.string()).default([]),
  // Labeled locations inside the project (mono/poly/mixed). `repo` (optional) makes that folder its own
  // git repo with that GitHub remote (polyrepo); empty = part of the principal/monorepo. Injected into
  // the agent brief (orientation) and into the allowed implementation scope.
  projectLayout: z
    .array(
      z.object({
        label: z.string(),
        path: z.string(),
        repo: z.object({ owner: z.string(), name: z.string() }).optional()
      })
    )
    .default([]),
  // The root/principal CODE repo (separate from the board's issueRepository). `path` "" = workspace root.
  principalRepo: z.object({ owner: z.string(), name: z.string(), path: z.string().optional() }).optional(),
  workflowTemplate: z.string(),
  statusMapping: WorkspaceStatusMappingSchema.default(defaultWorkspaceStatusMapping),
  leftPane: PaneDefaultSchema.optional(),
  rightPane: PaneDefaultSchema.optional(),
  description: z.string().optional(),
  agentInstructions: z.string().optional(),
  uatDeployCommand: z.string().optional(),
  uatDeployArgs: z.array(z.string()).default([]),
  // Operator-written release runbooks (sensitive: stored ONLY in the local config file; sent
  // nowhere except to the local agent CLI when a release step runs).
  uatReleaseInstructions: z.string().optional(),
  prodReleaseInstructions: z.string().optional()
});

export const AppDefaultsSchema = z.object({
  workspaceName: z.string().optional(),
  setupVersion: z.number().int().optional(),
  boardType: z.enum(["github", "jira", "none"]).optional(),
  automationLevel: z.enum(["manual", "semi", "auto"]).default("manual"),
  leftPane: PaneDefaultSchema,
  rightPane: PaneDefaultSchema
});

export const TandemConfigSchema = z.object({
  version: z.literal(1),
  workspaces: z.array(WorkspaceSchema).default([]),
  providers: z.record(z.string(), ProviderSchema),
  roles: z.record(z.string(), RoleSchema),
  workflows: z.record(z.string(), WorkflowSchema),
  ideaTypes: z.record(z.string(), IdeaTypeDefinitionSchema).default(IDEA_TYPE_DEFINITIONS),
  defaults: AppDefaultsSchema
});

export type TandemConfig = z.infer<typeof TandemConfigSchema>;

// Single source of truth for "which board does this workspace use", shared by renderer and main so
// they can never disagree. The EXPLICIT per-workspace `boardProvider` always wins — residual
// jiraSiteUrl / githubOwner fields left over from a previously-configured provider must NOT
// override what the user just chose in Settings (the bug where switching Jira→GitHub still showed
// Jira). Only when no explicit choice exists do we infer from configured fields, then the global
// default.
export function boardProviderForWorkspace(
  config: Pick<TandemConfig, "defaults"> | null | undefined,
  workspace?: TandemConfig["workspaces"][number]
): "github_project" | "jira" | "none" {
  if (workspace?.boardProvider === "jira") return "jira";
  if (workspace?.boardProvider === "github_project") return "github_project";
  if (workspace?.boardProvider === "none") return "none";
  if (workspace?.jiraSiteUrl) return "jira";
  if (workspace?.githubOwner || workspace?.projectNumber) return "github_project";
  const boardType = config?.defaults?.boardType ?? "github";
  if (boardType === "jira") return "jira";
  if (boardType === "none") return "none";
  return "github_project";
}

// "Deployable" = Twindem's UAT/prod deploy machinery (PR merge, gated deploy, release runbooks, deploy
// evidence gates) makes sense here. GitHub Project boards drive the PR/merge flow inherently; a Jira
// (or no-board) workspace is deployable only when the human wrote UAT/prod release instructions or a
// deploy command in Settings. When NOT deployable, UAT/prod/Done are plain human status moves and the
// deploy evidence gates are skipped (a board-only Jira project has no PRs/smoke tests to gate on).
export function isDeployableWorkspace(
  config: Pick<TandemConfig, "defaults"> | null | undefined,
  workspace?: TandemConfig["workspaces"][number]
): boolean {
  if (boardProviderForWorkspace(config, workspace) === "github_project") return true;
  return Boolean(
    workspace?.uatReleaseInstructions?.trim() ||
      workspace?.prodReleaseInstructions?.trim() ||
      workspace?.uatDeployCommand?.trim()
  );
}

// Editable code roots vs the execution boundary. `workspaceRoot` is where the agent RUNS; the returned
// roots are where it may CREATE/EDIT code. Deterministic + shared so the renderer brief and the
// context-builder orientation produce byte-identical roots. Paths are resolved absolute under the root.
export function resolveAllowedRoots(workspace?: TandemConfig["workspaces"][number]): string[] {
  const root = workspace?.root?.trim();
  if (!root) return [];
  const joinRoot = (p: string): string => {
    const norm = p.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
    return norm ? `${root.replace(/\/+$/, "")}/${norm}` : root;
  };
  const layout = (workspace?.projectLayout ?? []).filter((entry) => entry.path?.trim());
  const allowed = (workspace?.allowedRepoPaths ?? []).map((p) => p.trim()).filter(Boolean);
  const principalPath = workspace?.principalRepo?.path?.trim();
  const roots: string[] = [];
  if (workspace?.principalRepo) roots.push(joinRoot(principalPath ?? ""));
  for (const entry of layout) roots.push(joinRoot(entry.path));
  for (const p of allowed) roots.push(p.startsWith("/") ? p : joinRoot(p));
  // No explicit layout/principal/allowed → the workspace root itself is editable.
  if (roots.length === 0) roots.push(root);
  return Array.from(new Set(roots));
}

export type BoardCapability = { label: string; supported: boolean };

// What Twindem can/can't write to each board provider — single source for the board-setup display so
// the chooser is honest. (Linear: future — add a case when the integration lands.)
export function boardCapabilities(provider: "github_project" | "jira" | "none" | string): BoardCapability[] {
  if (provider === "jira") {
    return [
      { label: "Create board tasks (issues)", supported: true },
      { label: "Post comments & review notes", supported: true },
      { label: "Move workflow status (along the project's workflow)", supported: true },
      { label: "Create a new project", supported: true }
    ];
  }
  if (provider === "github_project") {
    return [
      { label: "Create board tasks (issues / draft items)", supported: true },
      { label: "Post comments & review notes", supported: true },
      { label: "Move workflow status", supported: true },
      { label: "Create a new project", supported: true }
    ];
  }
  return [{ label: "Nothing is written to a board — tasks are tracked only in Twindem (local)", supported: false }];
}

export const defaultConfig: TandemConfig = {
  version: 1,
  workspaces: [
    {
      name: "Local project",
      root: "",
      allowedRepoPaths: [],
      projectLayout: [],
      uatDeployArgs: [],
      workflowTemplate: "default",
      statusMapping: defaultWorkspaceStatusMapping
    }
  ],
  providers: {
    codex: { label: "Codex", command: "codex", args: [], resumeArgs: [], model: "CLI default", authMode: "subscription", apiKeyEnv: "OPENAI_API_KEY", supportsResume: true },
    // Codex cost control: pin the model and/or reasoning effort. Both flags verified against
    // codex-cli 0.139 (`-m/--model`, `-c model_reasoning_effort=`). Add other model ids via
    // Settings → Add profile if your CLI supports them.
    "codex-gpt-5-5-low": {
      label: "Codex",
      command: "codex",
      args: ["--model", "gpt-5.5", "-c", "model_reasoning_effort=low"],
      resumeArgs: [],
      model: "GPT 5.5 low effort — fast & cheap",
      supportsResume: true
    },
    "codex-gpt-5-5": {
      label: "Codex",
      command: "codex",
      args: ["--model", "gpt-5.5"],
      resumeArgs: [],
      model: "GPT 5.5 — balanced",
      supportsResume: true
    },
    "codex-gpt-5-5-high": {
      label: "Codex",
      command: "codex",
      args: ["--model", "gpt-5.5", "-c", "model_reasoning_effort=high"],
      resumeArgs: [],
      model: "GPT 5.5 high effort — thorough, pricier",
      supportsResume: true
    },
    "codex-gpt-5-4-mini-low": {
      label: "Codex",
      command: "codex",
      args: ["--model", "gpt-5.4-mini", "-c", "model_reasoning_effort=low"],
      resumeArgs: [],
      model: "GPT 5.4 mini low effort — cheaper",
      supportsResume: true
    },
    "codex-gpt-5-4-mini": {
      label: "Codex",
      command: "codex",
      args: ["--model", "gpt-5.4-mini"],
      resumeArgs: [],
      model: "GPT 5.4 mini — fast",
      supportsResume: true
    },
    "codex-gpt-5-4": {
      label: "Codex",
      command: "codex",
      args: ["--model", "gpt-5.4"],
      resumeArgs: [],
      model: "GPT 5.4 — balanced previous",
      supportsResume: true
    },
    "codex-gpt-5-1": {
      label: "Codex",
      command: "codex",
      args: ["--model", "gpt-5.1"],
      resumeArgs: [],
      model: "GPT 5.1 — previous gen",
      supportsResume: true
    },
    claude: { label: "Claude Code", command: "claude", args: [], resumeArgs: [], model: "CLI default", authMode: "subscription", apiKeyEnv: "ANTHROPIC_API_KEY", supportsResume: true },
    // NOTE: --model accepts the aliases "haiku"/"sonnet"/"opus" (latest of each tier) or full
    // model IDs (pinned). Versioned aliases like "opus-4.7" are NOT valid and kill the agent at
    // startup. Pinned IDs below so the cost/behavior is predictable; labels surface the cost tier.
    "claude-haiku-4-5": {
      label: "Claude",
      command: "claude",
      args: ["--model", "claude-haiku-4-5-20251001"],
      resumeArgs: [],
      model: "Haiku 4.5 — fast & cheapest",
      supportsResume: true
    },
    "claude-sonnet-4-6": {
      label: "Claude",
      command: "claude",
      args: ["--model", "claude-sonnet-4-6"],
      resumeArgs: [],
      model: "Sonnet 4.6 — balanced cost/quality",
      supportsResume: true
    },
    "claude-opus-4-8": {
      label: "Claude",
      command: "claude",
      args: ["--model", "claude-opus-4-8"],
      resumeArgs: [],
      model: "Opus 4.8 — top quality, expensive",
      supportsResume: true
    },
    shell: { label: "Shell", command: "zsh", args: ["-l"], resumeArgs: [], authMode: "none", supportsResume: false }
  },
  roles: {
    Author: {
      description: "Frames and owns issue/task definition",
      allowedActions: ["comment", "editIssueBody", "requestTaskReview", "createIssue"]
    },
    Reviewer: {
      description: "Reviews definitions and implementation evidence",
      allowedActions: ["comment", "recordReviewVerdict", "runTests"]
    },
    Implementer: {
      description: "Writes code and opens PRs",
      allowedActions: ["comment", "createBranch", "commit", "openPr", "recordTests"]
    },
    Verifier: {
      description: "Runs verification and smoke tests",
      allowedActions: ["comment", "recordSmokeTests", "recordVerification"]
    },
    "Release Operator": {
      description: "Handles deploy/release actions through gated app actions",
      allowedActions: ["comment", "recordDeployEvidence", "triggerDeploy"]
    },
    Researcher: {
      description: "Gathers context and prior art",
      allowedActions: ["comment", "research"]
    }
  },
  workflows: {
    default: {
      visiblePhases: ["Capture", "Define", "Review", "Execute", "Verify", "Done"],
      roundLimit: 3,
      projectStatusField: "Status",
      statusMap: {
        "capture.materializing": "Inbox",
        "define.drafting": "Planning",
        "review.definition": "Planning",
        "queue.ready": "Ready",
        "queue.todo": "Todo",
        "execute.implementing": "In Progress",
        "execute.reviewing_pr": "Review",
        "review.implementation": "Review",
        "verify.smoke_pending": "UAT",
        "verify.release_ready": "Release Ready",
        "complete.done": "Done",
        blocked: "Blocked",
        wont_do: "Wont Do"
      },
      gates: {
        requestTaskReview: ["issue_linked", "task_body_complete"],
        reviewOk: ["issue_linked", "task_body_complete"],
        uat: ["deploy_evidence"],
        done: ["smoke_tests_recorded", "final_verification_comment"]
      },
      labels: {
        taskReviewRequested: "needs-task-review",
        taskReviewOk: "review-done",
        taskReviewChanges: "review-done-please-correct"
      },
      instructionTemplates: {
        handoffReview:
          "You are receiving a Twindem review briefing from the other agent.\nTreat the text below as the full task-review context. Review the board task context first; do not start by searching the repository unless the artifact context is insufficient.\n\n{{summary}}\n\nIMPORTANT: You MUST respond with exactly one verdict: OK, Changes requested, or Blocked.\nIf changes are required, provide a concise checklist of what needs to change.\nYou MUST end your response with a structured result block on a new line:\nTWINDEM_RESULT: {\"verdict\":\"OK|Changes requested|Blocked\",\"summary\":\"your review summary\",\"nextAction\":\"what should happen next\",\"confidence\":0.8}",
        planning:
          "Human gate approved: start planning.\nPerform technical implementation analysis for the attached board task.\nUpdate the task body/comment with implementation design, risks, affected areas, acceptance criteria, and test plan.\nWhen Definition of Ready is complete, finish with:\nTWINDEM_RESULT: {\"marker\":\"DOR MET\",\"verdict\":\"OK\",\"summary\":\"...\",\"nextAction\":\"choose implementer\",\"confidence\":0.8}",
        implementation:
          "Human gate approved: you are the selected implementer.\nImplement the attached board task according to Definition of Ready.\nKeep changes scoped, record tests, and link branch/PR evidence.\nWhen ready for code review, finish with:\nTWINDEM_RESULT: {\"marker\":\"IMPLEMENTATION READY\",\"verdict\":\"OK\",\"summary\":\"...\",\"nextAction\":\"code review\",\"confidence\":0.8}",
        rework:
          "Twindem auto-route: {{loopLabel}} returned Changes requested.\nRequested corrections: {{summary}}\nUpdate the board artifact, code, or evidence as appropriate.\nWhen ready for re-review, finish with:\nTWINDEM_RESULT: {\"verdict\":\"OK\",\"summary\":\"updates ready for review\",\"nextAction\":\"review\",\"confidence\":0.8}",
        uatDeploy:
          "Human gate approved: deploy or trigger deploy to UAT for the attached task.\nUse the repository/runbook/CI flow available in the workspace. Do not touch PROD.\nAfter the UAT deploy trigger completes, record concrete evidence: command, CI link, rollout signal, or blocking reason.\nThen finish with:\nTWINDEM_RESULT: {\"verdict\":\"OK\",\"summary\":\"UAT deploy evidence recorded\",\"nextAction\":\"uat validation\",\"confidence\":0.8}"
      },
      evidenceKeys: [
        "issue_linked",
        "task_body_complete",
        "task_review_ok",
        "branch_or_pr_linked",
        "tests_recorded",
        "pr_review_approved",
        "deploy_evidence",
        "smoke_tests_recorded",
        "final_verification_comment"
      ],
      guardrails: {
        hard: [
          "no_ready_without_task_review_ok",
          "no_uat_without_deploy_evidence",
          "no_done_without_final_verification",
          "prod_actions_app_mediated_only_and_gated"
        ],
        soft: [
          "missing_acceptance_criteria",
          "missing_test_plan",
          "large_diff",
          "stale_branch",
          "manual_na_evidence"
        ]
      }
    }
  },
  ideaTypes: IDEA_TYPE_DEFINITIONS,
  defaults: {
    workspaceName: "Local project",
    setupVersion: 0,
    boardType: "github",
    automationLevel: "semi",
    leftPane: { role: "Author", roles: ["Author", "Implementer", "Verifier"], provider: "codex" },
    rightPane: { role: "Reviewer", roles: ["Reviewer", "Release Operator", "Researcher"], provider: "claude" }
  }
};
