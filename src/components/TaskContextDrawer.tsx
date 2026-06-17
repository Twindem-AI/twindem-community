// Task Context & Evidence drawer panels. New components live here (not in App.tsx) and receive
// only props — App.tsx composes them around the pre-existing sections (workflow map, issue viewer,
// evidence checklist, audit trail) to keep the drawer order from the spec.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { EvidenceRecord, ReviewFinding, SessionDetail, UsageSummary, VisiblePhase } from "../../shared/domain";
import type { TandemConfig } from "../../shared/config";
import { ideaTypeDefinition } from "../../shared/idea-types";
import { buildAgentContextPack, defaultInstructionModeForPhase } from "../../shared/context-builder";

type Workspace = TandemConfig["workspaces"][number];

const PHASE_ORDER: Array<VisiblePhase | "other"> = ["capture", "define", "review", "execute", "verify", "done", "other"];

const PHASE_LABELS: Record<string, string> = {
  capture: "Capture",
  define: "Define",
  review: "Review",
  execute: "Execute",
  verify: "Verify",
  done: "Done",
  other: "Other"
};

// Narrative-first kinds for the Decisions / Risks panel.
const DECISION_KINDS = new Set<EvidenceRecord["kind"]>(["decision", "risk", "follow_up", "approval"]);

function formatEvidenceTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function normalizePhase(phase: string): VisiblePhase | "other" {
  return (PHASE_ORDER as string[]).includes(phase) ? (phase as VisiblePhase) : "other";
}

export function BriefPanel({ detail, workspace }: { detail: SessionDetail; workspace?: Workspace }) {
  const session = detail.session;
  const type = ideaTypeDefinition(session.ideaType);
  const boardRef =
    session.repo && session.issueNumber
      ? `${session.repo}#${session.issueNumber}`
      : session.boardItemKey ?? session.boardItemId ?? "Not attached";
  const boardUrl = detail.board?.url ?? detail.github?.url ?? session.boardItemUrl;
  const status = detail.board?.status ?? detail.github?.projectStatus ?? session.visiblePhase;
  const rows: Array<[string, ReactNode]> = [
    ["Task", detail.board?.title || detail.github?.title || session.title],
    ["Workspace", workspace?.name ?? session.workspaceName ?? "Not set"],
    ["Board", session.boardProvider === "jira" ? "Jira" : session.boardProvider ? "GitHub Project" : "Local only"],
    ["Artifact", boardUrl ? <a href={boardUrl} target="_blank" rel="noreferrer">{boardRef}</a> : boardRef],
    ["Idea type", type.label],
    ["Phase / status", `${session.visiblePhase} · ${status}`],
    ["Required artifact", type.artifact]
  ];
  return (
    <section className="task-context-section">
      <h3>Brief</h3>
      <div className="context-brief-grid">
        {rows.map(([label, value]) => (
          <div key={label} className="context-brief-row">
            <small>{label}</small>
            <span>{value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function GovernancePanel({ detail, workspace }: { detail: SessionDetail; workspace?: Workspace }) {
  const phase = detail.session.visiblePhase;
  const pack = buildAgentContextPack({
    detail,
    workspace,
    side: "L",
    mode: defaultInstructionModeForPhase(phase)
  });
  return (
    <section className="task-context-section">
      <h3>Governance</h3>
      <div className="governance-list">
        <p>
          Requires implementation: <strong>{pack.requiresImplementation ? "yes" : "no"}</strong>
        </p>
        <small>Allowed now</small>
        <ul>
          {pack.allowedActions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
        <small>Not allowed</small>
        <ul>
          {pack.disallowedActions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
        {pack.qualityRules.length > 0 && (
          <>
            <small>Quality rules</small>
            <ul>
              {pack.qualityRules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </>
        )}
        {!pack.requiresImplementation && (
          <p className="governance-note">
            For Architecture/Research/Runbook tasks, code changes require explicit human approval.
          </p>
        )}
      </div>
    </section>
  );
}

function recordFindings(record: EvidenceRecord): ReviewFinding[] {
  const findings = record.details?.findings;
  return Array.isArray(findings) ? (findings as ReviewFinding[]) : [];
}

function EvidenceRow({ record }: { record: EvidenceRecord }) {
  const findings = recordFindings(record);
  return (
    <div className="compact-evidence-row">
      <div className="evidence-meta">
        <span className={`evidence-kind kind-${record.kind}`}>{record.kind.replace(/_/g, " ")}</span>
        <strong>{record.title}</strong>
        <small>
          {record.source ?? "app"}
          {record.agentSide ? ` · ${record.agentSide === "L" ? "Agent 1" : "Agent 2"}` : ""} ·{" "}
          {formatEvidenceTime(record.createdAt)}
        </small>
      </div>
      <p>{record.summary}</p>
      {findings.length > 0 && (
        <ul className="finding-list">
          {findings.map((finding) => (
            <li key={finding.id}>
              <code>{finding.id}</code>
              <span className={`finding-severity ${finding.severity}`}>
                {finding.severity === "blocking" ? "blocking" : "non-blocking"}
              </span>
              <span className="finding-title">
                {finding.title}
                {finding.file ? ` — ${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(record.boardUrl || record.rawRef || record.rawPath) && (
        <small className="evidence-raw">
          {record.boardUrl && (
            <a href={record.boardUrl} target="_blank" rel="noreferrer">
              board
            </a>
          )}
          {record.rawRef && <span>{record.rawRef}</span>}
          {record.rawPath && <span>{record.rawPath}</span>}
        </small>
      )}
    </div>
  );
}

export function CompactEvidencePanel({ records }: { records: EvidenceRecord[] }) {
  const groups = PHASE_ORDER.map((phase) => ({
    phase,
    // Newest first within each phase group.
    items: records.filter((record) => normalizePhase(record.phase) === phase).reverse()
  })).filter((group) => group.items.length > 0);
  return (
    <section className="task-context-section">
      <h3>Evidence</h3>
      {groups.length === 0 ? (
        <p className="task-context-empty">No evidence recorded yet — records appear as the task progresses.</p>
      ) : (
        <div className="compact-evidence-list">
          {groups.map((group) => (
            <div key={group.phase}>
              <small className="evidence-phase-label">{PHASE_LABELS[group.phase]}</small>
              {group.items.map((record) => (
                <EvidenceRow key={record.id} record={record} />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function DecisionEvidencePanel({ records }: { records: EvidenceRecord[] }) {
  const decisions = records.filter((record) => DECISION_KINDS.has(record.kind)).reverse();
  if (decisions.length === 0) return null;
  return (
    <section className="task-context-section">
      <h3>Decisions / Risks</h3>
      <div className="compact-evidence-list">
        {decisions.map((record) => (
          <EvidenceRow key={record.id} record={record} />
        ))}
      </div>
    </section>
  );
}

function formatVolume(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

// Signal-only threshold: above this estimated volume for one agent, suggest (never force) a
// compact restart. Keep this well below "scary bill" territory; the value is terminal-volume
// estimate, not billed tokens.
const HIGH_AGENT_VOLUME_ESTIMATE = 60_000;

// TUI mode shows VOLUME estimates only — never billed tokens or dollars (those require real API
// usage data from a future headless mode).
export function CostSummaryPanel({ detail }: { detail: SessionDetail }) {
  // detail.usageSummary comes from the DB without flushing the in-memory accumulators, so during a
  // live run it lags up to one flush interval. While the drawer is open, poll usage.summary (whose
  // IPC handler flushes accumulators first) so the panel reflects the live volume.
  const [liveSummary, setLiveSummary] = useState<UsageSummary | undefined>(detail.usageSummary);
  useEffect(() => {
    setLiveSummary(detail.usageSummary);
  }, [detail.usageSummary]);
  useEffect(() => {
    const sessionId = detail.session.id;
    let cancelled = false;
    const tick = async () => {
      const result = await window.tandem.usage.summary(sessionId);
      if (!cancelled && result.ok && result.data) setLiveSummary(result.data);
    };
    const interval = window.setInterval(() => void tick(), 6000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [detail.session.id]);

  const summary = liveSummary;
  const heavyAgent = summary?.byAgent.find(
    (agent) => agent.side && agent.totalEstimateTokens > HIGH_AGENT_VOLUME_ESTIMATE
  );
  return (
    <section className="task-context-section">
      <h3>Cost</h3>
      <p className="cost-disclaimer">
        Estimated terminal context volume — rough size of what flowed through the agent terminals. Not billed tokens.
      </p>
      <div className="cost-optimization-note">
        <strong>Optimized for two agents:</strong> compact prompts, delta reviews, no transcript replay on resume, and duplicate
        signal guards keep Agent 1/Agent 2 from paying for the same context repeatedly.
      </div>
      {!summary ? (
        <p className="task-context-empty">No usage recorded yet — estimates appear once an agent runs.</p>
      ) : (
        <div className="cost-metric-grid">
          <div className="cost-metric">
            <small>Total</small>
            <strong>~{formatVolume(summary.totalEstimateTokens)}</strong>
          </div>
          <div className="cost-metric">
            <small>Input / output</small>
            <strong>
              ~{formatVolume(summary.inputEstimateTokens)} / ~{formatVolume(summary.outputEstimateTokens)}
            </strong>
          </div>
          <div className="cost-metric">
            <small>Review rounds</small>
            <strong>
              {detail.session.roundN}/{detail.session.roundTotal}
            </strong>
          </div>
          {summary.byAgent.map((agent) => (
            <div className="cost-metric" key={`${agent.side ?? "?"}-${agent.provider ?? "?"}-${agent.model ?? "?"}`}>
              <small>
                {agent.side === "L" ? "Agent 1" : agent.side === "R" ? "Agent 2" : "App"}
                {agent.model ? ` · ${agent.model}` : agent.provider ? ` · ${agent.provider}` : ""}
              </small>
              <strong>~{formatVolume(agent.totalEstimateTokens)}</strong>
            </div>
          ))}
          {summary.byPhase.map((phase) => (
            <div className="cost-metric" key={phase.phase}>
              <small>Phase · {PHASE_LABELS[phase.phase] ?? phase.phase}</small>
              <strong>~{formatVolume(phase.totalEstimateTokens)}</strong>
            </div>
          ))}
        </div>
      )}
      {heavyAgent && (
        <p className="cost-restart-hint">
          {heavyAgent.side === "L" ? "Agent 1" : "Agent 2"} has a high context volume (~
          {formatVolume(heavyAgent.totalEstimateTokens)}). Consider <strong>⟳ Compact restart</strong> on its pane —
          it re-seeds the agent from the decision trail without losing state.
        </p>
      )}
    </section>
  );
}

export function RawRefsPanel({ detail, workspace }: { detail: SessionDetail; workspace?: Workspace }) {
  const pack = buildAgentContextPack({ detail, workspace, side: "L", mode: "orientation" });
  const deployWithOutput = detail.deployAttempts.find((attempt) => attempt.output || attempt.error);
  return (
    <section className="task-context-section">
      <h3>Raw links</h3>
      <ul className="raw-ref-list">
        {pack.rawRefs.map((ref) => (
          <li key={`${ref.kind}:${ref.url ?? ref.path ?? ref.label}`}>
            <small>{ref.kind}</small>
            {ref.url ? (
              <a href={ref.url} target="_blank" rel="noreferrer">
                {ref.label}
              </a>
            ) : (
              <span>
                {ref.label}: <code>{ref.path}</code>
              </span>
            )}
          </li>
        ))}
        {deployWithOutput && (
          <li>
            <small>log</small>
            <span>Latest deploy output is on the deploy attempt record ({deployWithOutput.status}).</span>
          </li>
        )}
      </ul>
    </section>
  );
}
