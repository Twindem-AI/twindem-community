import type { BoardStatusSlot, TandemConfig } from "./config.js";
import { defaultWorkspaceStatusMapping } from "./config.js";
import type { SessionStatus, VisiblePhase } from "./domain.js";

export type WorkspaceConfig = TandemConfig["workspaces"][number];

export const BOARD_STATUS_SLOT_ORDER: BoardStatusSlot[] = [
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
];

export const MAIN_TRACK_STATUS_SLOTS = new Set<BoardStatusSlot>([
  "inbox",
  "planning",
  "in_progress",
  "review",
  "uat",
  "done"
]);

export const PROPOSABLE_STATUS_SLOTS: BoardStatusSlot[] = ["inbox", "planning", "in_progress", "uat"];

const IGNORED_BOARD_STATUSES = new Set(["", "no status", "open", "closed"]);

const SLOT_FALLBACK_LABELS: Record<BoardStatusSlot, string[]> = {
  inbox: ["Inbox", "Backlog", "Triage"],
  planning: ["Planning", "Selected for Development", "Refinement"],
  ready: ["Ready"],
  todo: ["Todo", "To Do"],
  in_progress: ["In Progress"],
  review: ["Review", "In Review"],
  uat: ["UAT", "Testing", "QA", "Staging"],
  release_ready: ["Release Ready"],
  done: ["Done", "Complete", "Completed"],
  blocked: ["Blocked"],
  wont_do: ["Wont Do", "Won't Do", "Canceled", "Cancelled"]
};

const SLOT_PHASE_LABELS: Record<BoardStatusSlot, string> = {
  inbox: "Capture",
  planning: "Define",
  ready: "Define",
  todo: "Execute",
  in_progress: "Execute",
  review: "Review",
  uat: "Verify",
  release_ready: "Verify",
  done: "Done",
  blocked: "Blocked",
  wont_do: "Canceled"
};

const SLOT_SESSION_STATE: Record<
  BoardStatusSlot,
  { visiblePhase: VisiblePhase; internalState: string; sessionStatus: SessionStatus }
> = {
  inbox: { visiblePhase: "capture", internalState: "capture.materializing", sessionStatus: "waiting" },
  planning: { visiblePhase: "define", internalState: "define.drafting", sessionStatus: "waiting" },
  ready: { visiblePhase: "define", internalState: "queue.ready", sessionStatus: "waiting" },
  todo: { visiblePhase: "define", internalState: "queue.todo", sessionStatus: "waiting" },
  in_progress: { visiblePhase: "execute", internalState: "execute.implementing", sessionStatus: "running" },
  review: { visiblePhase: "review", internalState: "review.implementation", sessionStatus: "running" },
  uat: { visiblePhase: "verify", internalState: "verify.smoke_pending", sessionStatus: "waiting" },
  release_ready: { visiblePhase: "verify", internalState: "verify.release_ready", sessionStatus: "waiting" },
  done: { visiblePhase: "done", internalState: "complete.done", sessionStatus: "done" },
  blocked: { visiblePhase: "review", internalState: "blocked", sessionStatus: "blocked" },
  wont_do: { visiblePhase: "done", internalState: "wont_do", sessionStatus: "done" }
};

const JIRA_WRITE_FALLBACKS: Partial<Record<BoardStatusSlot, string>> = {
  planning: "Refinement"
};

export function normalizeBoardStatus(value?: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isRealBoardStatus(value?: string | null): boolean {
  return !IGNORED_BOARD_STATUSES.has(normalizeBoardStatus(value));
}

export function slotForBoardStatus(value?: string | null, workspace?: WorkspaceConfig): BoardStatusSlot | null {
  const normalized = normalizeBoardStatus(value);
  if (IGNORED_BOARD_STATUSES.has(normalized)) return null;

  // A status the user explicitly marked "outside Twindem workflow" resolves to no slot — and must do so
  // BEFORE default aliases, so an ignored status isn't silently remapped by the generic read table.
  const ignored = workspace?.statusMapping?.ignored ?? [];
  if (ignored.some((status) => normalizeBoardStatus(status) === normalized)) return null;

  const exact = new Map<string, BoardStatusSlot>();
  for (const [status, slot] of Object.entries(defaultWorkspaceStatusMapping.read)) {
    exact.set(normalizeBoardStatus(status), slot);
  }
  for (const [status, slot] of Object.entries(workspace?.statusMapping?.read ?? {})) {
    exact.set(normalizeBoardStatus(status), slot);
  }

  const exactSlot = exact.get(normalized);
  if (exactSlot) return exactSlot;

  const sortedAliases = Array.from(exact.entries()).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, slot] of sortedAliases) {
    if (alias && normalized.includes(alias)) return slot;
  }
  return null;
}

export function boardStatusForSlot(slot: BoardStatusSlot, workspace?: WorkspaceConfig): string {
  const configured = workspace?.statusMapping?.write?.[slot]?.trim();
  const genericDefault = defaultWorkspaceStatusMapping.write[slot];
  if (workspace?.boardProvider === "jira" && (!configured || configured === genericDefault)) {
    return JIRA_WRITE_FALLBACKS[slot] ?? genericDefault ?? SLOT_FALLBACK_LABELS[slot][0];
  }
  return configured || genericDefault || SLOT_FALLBACK_LABELS[slot][0];
}

export function boardStatusCandidatesForSlot(slot: BoardStatusSlot, workspace?: WorkspaceConfig): string[] {
  return uniqueStatuses([
    boardStatusForSlot(slot, workspace),
    ...(workspace?.statusMapping?.read
      ? Object.entries(workspace.statusMapping.read)
          .filter(([, candidateSlot]) => candidateSlot === slot)
          .map(([status]) => status)
      : []),
    ...(defaultWorkspaceStatusMapping.read
      ? Object.entries(defaultWorkspaceStatusMapping.read)
          .filter(([, candidateSlot]) => candidateSlot === slot)
          .map(([status]) => status)
      : []),
    ...SLOT_FALLBACK_LABELS[slot]
  ]);
}

export function boardStatusOptions(workspace?: WorkspaceConfig): Array<{ slot: BoardStatusSlot; label: string; phase: string }> {
  return BOARD_STATUS_SLOT_ORDER.map((slot) => ({
    slot,
    label: boardStatusForSlot(slot, workspace),
    phase: SLOT_PHASE_LABELS[slot]
  }));
}

export function boardStatusPhaseLabel(slot: BoardStatusSlot | null): string {
  return slot ? SLOT_PHASE_LABELS[slot] : SLOT_PHASE_LABELS.inbox;
}

export function sessionStateForSlot(slot: BoardStatusSlot): {
  visiblePhase: VisiblePhase;
  internalState: string;
  sessionStatus: SessionStatus;
} {
  return SLOT_SESSION_STATE[slot];
}

export function phaseIndexForSlot(slot: BoardStatusSlot | null): number {
  if (slot === "done" || slot === "wont_do") return 4;
  if (slot === "uat" || slot === "release_ready") return 3;
  if (slot === "in_progress" || slot === "review" || slot === "todo") return 2;
  if (slot === "planning" || slot === "ready") return 1;
  return 0;
}

type WriteMapping = Partial<Record<BoardStatusSlot, string>>;
type ReadMapping = Record<string, BoardStatusSlot>;

// Status names that indicate a slot, for auto-matching against a board's real statuses.
function slotAliasNames(slot: BoardStatusSlot): string[] {
  const names: string[] = [];
  const write = defaultWorkspaceStatusMapping.write[slot];
  if (write) names.push(write);
  for (const [status, mapped] of Object.entries(defaultWorkspaceStatusMapping.read)) {
    if (mapped === slot) names.push(status);
  }
  names.push(...SLOT_FALLBACK_LABELS[slot]);
  return names;
}

// Invert a write map (status → slot). On a duplicate status (two slots write the same name), the
// EARLIER main-track slot wins (so "In Progress" reads back as in_progress, not uat).
function invertWrite(write?: WriteMapping): Map<string, BoardStatusSlot> {
  const byStatus = new Map<string, BoardStatusSlot>();
  const order = (slot: BoardStatusSlot) => BOARD_STATUS_SLOT_ORDER.indexOf(slot);
  for (const [slot, status] of Object.entries(write ?? {})) {
    if (!status) continue;
    const norm = normalizeBoardStatus(status);
    const existing = byStatus.get(norm);
    if (!existing || order(slot as BoardStatusSlot) < order(existing)) byStatus.set(norm, slot as BoardStatusSlot);
  }
  return byStatus;
}

// Propose `write` (slot → real status) from a board's real statuses. A slot is kept as user-confirmed
// only when its existing value differs from the generic default AND still exists on the board; otherwise
// it is (re)mapped from the real statuses by name. Slots with no plausible match stay empty.
export function autoMapWrite(statuses: string[], existing?: WriteMapping): WriteMapping {
  const real = new Map<string, string>();
  for (const status of statuses) real.set(normalizeBoardStatus(status), status);
  const result: WriteMapping = {};
  for (const slot of BOARD_STATUS_SLOT_ORDER) {
    if (!MAIN_TRACK_STATUS_SLOTS.has(slot)) continue;
    const existingVal = existing?.[slot]?.trim();
    const isDefault = existingVal !== undefined && existingVal === defaultWorkspaceStatusMapping.write[slot];
    if (existingVal && !isDefault && real.has(normalizeBoardStatus(existingVal))) {
      result[slot] = real.get(normalizeBoardStatus(existingVal))!;
      continue;
    }
    const match = slotAliasNames(slot)
      .map((name) => normalizeBoardStatus(name))
      .find((norm) => real.has(norm));
    if (match) result[slot] = real.get(match)!;
  }
  return result;
}

// Seed read map (status → slot): defaults overlaid with the write inversion. Used as a seed for
// autoMapRead; the user-edited read grid is the source of truth once curated.
export function deriveReadMapping(write?: WriteMapping): ReadMapping {
  const read: ReadMapping = { ...defaultWorkspaceStatusMapping.read };
  const order = (slot: BoardStatusSlot) => BOARD_STATUS_SLOT_ORDER.indexOf(slot);
  const chosen = new Map<string, { slot: BoardStatusSlot; name: string }>();
  for (const [slot, status] of Object.entries(write ?? {})) {
    if (!status) continue;
    const norm = normalizeBoardStatus(status);
    const existing = chosen.get(norm);
    if (!existing || order(slot as BoardStatusSlot) < order(existing.slot)) {
      chosen.set(norm, { slot: slot as BoardStatusSlot, name: status });
    }
  }
  for (const { slot, name } of chosen.values()) read[name] = slot;
  return read;
}

// Propose a read slot for each real status: existing override → write inversion → default alias match.
// Ignored statuses are skipped. Statuses with no proposal are left out (the UI forces a manual choice).
export function autoMapRead(
  statuses: string[],
  write?: WriteMapping,
  existingRead?: ReadMapping,
  ignored?: string[]
): ReadMapping {
  const ignoredSet = new Set((ignored ?? []).map((status) => normalizeBoardStatus(status)));
  const existingNorm = new Map<string, BoardStatusSlot>();
  for (const [status, slot] of Object.entries(existingRead ?? {})) existingNorm.set(normalizeBoardStatus(status), slot);
  const writeInv = invertWrite(write);
  const read: ReadMapping = {};
  for (const status of statuses) {
    const norm = normalizeBoardStatus(status);
    if (ignoredSet.has(norm)) continue;
    const fromExisting = existingNorm.get(norm);
    if (fromExisting) {
      read[status] = fromExisting;
      continue;
    }
    const fromWrite = writeInv.get(norm);
    if (fromWrite) {
      read[status] = fromWrite;
      continue;
    }
    const fromDefault = slotForBoardStatus(status);
    if (fromDefault) read[status] = fromDefault;
  }
  return read;
}

// Real statuses that are neither mapped in `read` nor explicitly ignored — used to gate save.
export function unaccountedStatuses(statuses: string[], read?: ReadMapping, ignored?: string[]): string[] {
  const ignoredSet = new Set((ignored ?? []).map((status) => normalizeBoardStatus(status)));
  const readNorm = new Set(Object.keys(read ?? {}).map((status) => normalizeBoardStatus(status)));
  return statuses.filter((status) => {
    const norm = normalizeBoardStatus(status);
    return !ignoredSet.has(norm) && !readNorm.has(norm);
  });
}

export function statusLabelForVisiblePhase(phase?: string, workspace?: WorkspaceConfig): string {
  if (phase === "capture") return boardStatusForSlot("inbox", workspace);
  if (phase === "define") return boardStatusForSlot("planning", workspace);
  if (phase === "review") return boardStatusForSlot("review", workspace);
  if (phase === "execute") return boardStatusForSlot("in_progress", workspace);
  if (phase === "verify") return boardStatusForSlot("uat", workspace);
  if (phase === "done") return boardStatusForSlot("done", workspace);
  return boardStatusForSlot("inbox", workspace);
}

export function boardColumnSortKeyForStatus(status: string, workspace?: WorkspaceConfig): number {
  if (normalizeBoardStatus(status) === "no status") return 999;
  const slot = slotForBoardStatus(status, workspace);
  if (!slot) return 500;
  const index = BOARD_STATUS_SLOT_ORDER.indexOf(slot);
  return index === -1 ? 500 : index;
}

function uniqueStatuses(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const status = value.trim();
    const key = normalizeBoardStatus(status);
    if (!status || seen.has(key)) continue;
    seen.add(key);
    result.push(status);
  }
  return result;
}
