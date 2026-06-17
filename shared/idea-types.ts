import type { IdeaType } from "./domain.js";

export type IdeaPhaseKey = "planning" | "in_progress" | "review" | "uat" | "done";

// Quality rules guard against over-compaction: `preserve` must survive every summary, handoff,
// and compact-evidence record; `compact` is the ONLY content agents may drop or shorten.
export type IdeaTypeQuality = {
  preserve: string[];
  compact: string[];
  requiredSections: string[];
  doneEvidence: string[];
};

export type IdeaTypeDefinition = {
  key: IdeaType;
  label: string;
  artifact: string;
  requiresImplementation: boolean;
  summary: string;
  labelName: string;
  phases: Record<IdeaPhaseKey, string>;
  evidence: string;
  quality: IdeaTypeQuality;
};

export const IDEA_TYPE_DEFINITIONS: Record<IdeaType, IdeaTypeDefinition> = {
  feature: {
    key: "feature",
    label: "Feature",
    artifact: "implementation",
    requiresImplementation: true,
    summary: "New product behavior, UI, integration, automation, or workflow change.",
    labelName: "feature",
    phases: {
      planning: "Technical plan + acceptance criteria",
      in_progress: "Implementation",
      review: "Agent 2 code review",
      uat: "User testing / validation",
      done: "Merged or released"
    },
    evidence: "Implementation summary, tests/checks, review result, and acceptance evidence.",
    quality: {
      preserve: ["scope and approach", "decisions and constraints", "acceptance criteria", "test plan", "open questions"],
      compact: ["raw logs", "exploratory command output", "repeated file listings", "duplicate terminal output"],
      requiredSections: [
        "Problem",
        "Scope / approach",
        "Affected areas inside the workspace root",
        "Acceptance criteria",
        "Test plan",
        "Open questions"
      ],
      doneEvidence: ["implementation summary recorded", "tests/checks recorded", "review result recorded", "acceptance evidence recorded"]
    }
  },
  bug: {
    key: "bug",
    label: "Bug",
    artifact: "fix",
    requiresImplementation: true,
    summary: "Defect repair, regression, broken flow, or incorrect behavior.",
    labelName: "bug",
    phases: {
      planning: "Reproduction + root cause",
      in_progress: "Fix",
      review: "Regression review",
      uat: "Bug fix verification",
      done: "Confirmed fixed"
    },
    evidence: "Reproduction evidence, root cause, fix summary, and regression verification.",
    quality: {
      preserve: ["reproduction steps", "root cause", "fix approach", "regression verification", "open questions"],
      compact: ["raw logs", "exploratory command output", "repeated file listings", "duplicate terminal output"],
      requiredSections: ["Reproduction", "Root cause", "Fix approach", "Regression test plan", "Open questions"],
      doneEvidence: ["reproduction recorded", "root cause recorded", "fix summary recorded", "regression verification recorded"]
    }
  },
  spike: {
    key: "spike",
    label: "Spike",
    artifact: "prototype / feasibility proof",
    requiresImplementation: false,
    summary: "Time-boxed technical exploration, proof of concept, or feasibility validation.",
    labelName: "spike",
    phases: {
      planning: "Question + experiment plan",
      in_progress: "Prototype / feasibility proof",
      review: "Evidence review",
      uat: "Decision checkpoint",
      done: "Spike accepted"
    },
    evidence: "Experiment question, prototype or notes, findings, recommendation, and decision evidence.",
    quality: {
      preserve: [
        "question being answered",
        "experiment scope",
        "constraints",
        "prototype approach",
        "findings",
        "recommendation",
        "ADR conclusion update",
        "follow-up tasks"
      ],
      compact: ["raw logs", "exploratory command output", "repeated file listings", "duplicate terminal output"],
      requiredSections: [
        "Question",
        "Experiment plan",
        "Prototype scope",
        "Findings",
        "Recommendation",
        "ADR conclusion update",
        "Follow-up tasks",
        "Open questions"
      ],
      doneEvidence: [
        "experiment recorded",
        "prototype or feasibility evidence recorded",
        "review result recorded",
        "ADR conclusion update recorded",
        "decision recorded"
      ]
    }
  },
  architecture: {
    key: "architecture",
    label: "Architecture",
    artifact: "ADR / technical decision",
    requiresImplementation: false,
    summary: "Project foundations, stack choice, cloud architecture, service boundaries, or security posture.",
    labelName: "architecture",
    phases: {
      planning: "Options + ADR draft",
      in_progress: "Decision document / optional proof of concept",
      review: "Challenge review",
      uat: "Human / stakeholder approval",
      done: "ADR accepted"
    },
    evidence: "ADR/proposal, alternatives considered, risks/tradeoffs, Agent 2 challenge, and human approval.",
    quality: {
      preserve: [
        "problem statement",
        "constraints",
        "options considered",
        "recommended decision",
        "rejected alternatives",
        "tradeoffs",
        "risks",
        "validation plan",
        "follow-up tasks"
      ],
      compact: ["raw logs", "exploratory command output", "repeated file listings", "duplicate terminal output"],
      requiredSections: [
        "Decision/problem statement",
        "Options considered",
        "Recommended approach",
        "Tradeoffs & risks",
        "Validation / evidence plan",
        "Open questions"
      ],
      doneEvidence: ["ADR/proposal recorded", "Agent 2 challenge review complete", "human approval recorded"]
    }
  },
  research: {
    key: "research",
    label: "Research",
    artifact: "findings + recommendation",
    requiresImplementation: false,
    summary: "Comparison, feasibility check, spike, or discovery without guaranteed code.",
    labelName: "research",
    phases: {
      planning: "Research questions + scope",
      in_progress: "Investigation / comparison",
      review: "Critique findings",
      uat: "Decision checkpoint",
      done: "Recommendation accepted"
    },
    evidence: "Sources or observations, comparison matrix, recommendation, open questions, and human decision.",
    quality: {
      preserve: ["sources", "comparison matrix", "assumptions", "recommendation", "confidence and limitations", "open questions"],
      compact: ["raw search output", "duplicate snippets", "repeated command output"],
      requiredSections: ["Research questions", "Sources", "Comparison", "Recommendation", "Open questions"],
      doneEvidence: ["findings and recommendation recorded", "Agent 2 critique complete", "human decision recorded"]
    }
  },
  runbook: {
    key: "runbook",
    label: "Runbook",
    artifact: "procedure / checklist",
    requiresImplementation: false,
    summary: "Release process, deployment procedure, incident process, or operational playbook.",
    labelName: "runbook",
    phases: {
      planning: "Scope + preconditions",
      in_progress: "Procedure drafting",
      review: "Safety / reliability review",
      uat: "Dry-run / validation",
      done: "Runbook approved"
    },
    evidence: "Procedure, prerequisites, validation steps, rollback/safety notes, and dry-run or review evidence.",
    quality: {
      preserve: ["prerequisites", "procedure steps", "validation steps", "rollback procedure", "safety notes"],
      compact: ["repeated command output", "raw logs", "duplicate terminal output"],
      requiredSections: ["Prerequisites", "Procedure", "Validation steps", "Rollback", "Safety notes", "Open questions"],
      doneEvidence: ["runbook recorded", "safety review complete", "dry-run or validation evidence recorded"]
    }
  }
};

export const IDEA_TYPES = Object.values(IDEA_TYPE_DEFINITIONS);

export function ideaTypeDefinition(type?: string | null): IdeaTypeDefinition {
  if (type && type in IDEA_TYPE_DEFINITIONS) {
    return IDEA_TYPE_DEFINITIONS[type as IdeaType];
  }
  return IDEA_TYPE_DEFINITIONS.feature;
}

export function inferIdeaType(input: {
  explicit?: string | null;
  title?: string | null;
  labels?: string[] | null;
  quickNoteKind?: "idea" | "bug";
}): IdeaType {
  if (input.explicit && input.explicit in IDEA_TYPE_DEFINITIONS) return input.explicit as IdeaType;
  if (input.quickNoteKind === "bug") return "bug";
  const labels = (input.labels ?? []).map((label) => label.toLowerCase());
  const labelMatch = IDEA_TYPES.find((type) => labels.includes(type.labelName.toLowerCase()));
  if (labelMatch) return labelMatch.key;
  if (/^\s*\[bug\]/i.test(input.title ?? "")) return "bug";
  if (/^\s*\[spike\]|\bspike\b/i.test(input.title ?? "")) return "spike";
  return "feature";
}

export function labelsForIdeaType(type?: string | null): string[] {
  const definition = ideaTypeDefinition(type);
  return definition.key === "feature" ? [] : [definition.labelName];
}
