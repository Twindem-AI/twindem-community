import { useState } from "react";
import type { BoardStatusSlot } from "../../shared/config";
import {
  BOARD_STATUS_SLOT_ORDER,
  MAIN_TRACK_STATUS_SLOTS,
  normalizeBoardStatus
} from "../../shared/status-mapping";

export type StatusMappingValue = {
  write: Partial<Record<BoardStatusSlot, string>>;
  read: Record<string, BoardStatusSlot>;
  ignored: string[];
};

// Slots the read grid can target, and their friendly labels. Main-track slots plus the two terminal
// slots — the full 11-slot vocabulary would be noise for a mapping UI.
const READ_SLOT_OPTIONS: BoardStatusSlot[] = ["inbox", "planning", "in_progress", "review", "uat", "done", "blocked", "wont_do"];
const TERMINAL_SLOTS: BoardStatusSlot[] = ["blocked", "wont_do"];
const SLOT_LABELS: Record<BoardStatusSlot, string> = {
  inbox: "Inbox / Backlog",
  planning: "Planning / Refinement",
  ready: "Ready",
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  uat: "UAT / Verify",
  release_ready: "Release Ready",
  done: "Done",
  blocked: "Blocked",
  wont_do: "Won't Do / Cancelled"
};

const IGNORE_VALUE = "__ignore__";

function mainTrackSlots(): BoardStatusSlot[] {
  return BOARD_STATUS_SLOT_ORDER.filter((slot) => MAIN_TRACK_STATUS_SLOTS.has(slot));
}

// Statuses written by 2+ main-track slots — allowed, but the external read tie-break picks one slot.
function duplicateWrites(write: StatusMappingValue["write"]): string[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const slot of mainTrackSlots()) {
    const status = write[slot]?.trim();
    if (!status) continue;
    const norm = normalizeBoardStatus(status);
    const entry = counts.get(norm) ?? { name: status, count: 0 };
    entry.count += 1;
    counts.set(norm, entry);
  }
  return Array.from(counts.values())
    .filter((entry) => entry.count > 1)
    .map((entry) => entry.name);
}

export function StatusMappingEditor({
  statuses,
  value,
  onChange,
  loading,
  onRefresh,
  error,
  unioned
}: {
  statuses: string[];
  value: StatusMappingValue;
  onChange: (next: StatusMappingValue) => void;
  loading?: boolean;
  onRefresh: () => void;
  error?: string | null;
  unioned?: boolean;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { write, read, ignored } = value;
  const ignoredSet = new Set(ignored.map((status) => normalizeBoardStatus(status)));
  const readByNorm = new Map<string, BoardStatusSlot>();
  for (const [status, slot] of Object.entries(read)) readByNorm.set(normalizeBoardStatus(status), slot);

  function setWriteSlot(slot: BoardStatusSlot, status: string) {
    const nextWrite = { ...write };
    if (status) nextWrite[slot] = status;
    else delete nextWrite[slot];
    onChange({ ...value, write: nextWrite });
  }

  function setReadStatus(status: string, choice: string) {
    const norm = normalizeBoardStatus(status);
    const nextRead: Record<string, BoardStatusSlot> = {};
    for (const [key, slot] of Object.entries(read)) {
      if (normalizeBoardStatus(key) !== norm) nextRead[key] = slot;
    }
    const nextIgnored = ignored.filter((entry) => normalizeBoardStatus(entry) !== norm);
    if (choice === IGNORE_VALUE) {
      nextIgnored.push(status);
    } else if (choice) {
      nextRead[status] = choice as BoardStatusSlot;
    }
    // choice === "" → unset (status becomes unaccounted; save gate will flag it)
    onChange({ ...value, read: nextRead, ignored: nextIgnored });
  }

  if (statuses.length === 0) {
    return (
      <div className="status-mapping-editor empty">
        <p className="field-optional">
          {error ? error : "No statuses loaded yet. Pick a Jira project, then load its statuses to map them."}
        </p>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading…" : "Load statuses"}
        </button>
      </div>
    );
  }

  const dupes = duplicateWrites(write);

  return (
    <div className="status-mapping-editor">
      {unioned && (
        <p className="status-map-warning">
          Couldn't match this project's issue type — statuses shown are across all issue types. Some may
          not be reachable for the issue type Twindem creates.
        </p>
      )}

      <div className="status-map-section">
        <h4>Twindem step → Jira status (moves)</h4>
        <p className="field-optional">When Twindem advances a step, it moves the issue to this status.</p>
        <div className="status-map-grid">
          {mainTrackSlots().map((slot) => (
            <div className="status-map-row" key={slot}>
              <span className="status-map-slot">{SLOT_LABELS[slot]}</span>
              <select value={write[slot] ?? ""} onChange={(event) => setWriteSlot(slot, event.target.value)}>
                <option value="">— not mapped —</option>
                {statuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        {dupes.length > 0 && (
          <p className="field-optional">
            Allowed: Twindem persists the explicit target step for its own moves. External Jira sync will
            read {dupes.map((name) => `"${name}"`).join(", ")} as the earlier step.
          </p>
        )}
      </div>

      <div className="status-map-section">
        <button type="button" className="link-button" onClick={() => setShowAdvanced((prev) => !prev)}>
          {showAdvanced ? "Hide" : "Show"} advanced / terminal statuses
        </button>
        {showAdvanced && (
          <div className="status-map-grid">
            {TERMINAL_SLOTS.map((slot) => (
              <div className="status-map-row" key={slot}>
                <span className="status-map-slot">{SLOT_LABELS[slot]}</span>
                <select value={write[slot] ?? ""} onChange={(event) => setWriteSlot(slot, event.target.value)}>
                  <option value="">— not mapped —</option>
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <p className="field-optional">
              "Won't Do" is used when a task is cancelled/closed. If this board has no Cancelled status,
              map it to a final status (e.g. Done) so close/cancel still works.
            </p>
          </div>
        )}
      </div>

      <div className="status-map-section">
        <h4>Jira status → Twindem step (reads)</h4>
        <p className="field-optional">
          Every board status must map to a step or be marked outside the workflow — nothing stays
          unaccounted.
        </p>
        <div className="status-map-grid">
          {statuses.map((status) => {
            const norm = normalizeBoardStatus(status);
            const current = ignoredSet.has(norm) ? IGNORE_VALUE : readByNorm.get(norm) ?? "";
            return (
              <div className="status-map-row" key={status}>
                <span className="status-map-slot">{status}</span>
                <select value={current} onChange={(event) => setReadStatus(status, event.target.value)}>
                  <option value="">— choose —</option>
                  {READ_SLOT_OPTIONS.map((slot) => (
                    <option key={slot} value={slot}>
                      {SLOT_LABELS[slot]}
                    </option>
                  ))}
                  <option value={IGNORE_VALUE}>Ignore / outside Twindem workflow</option>
                </select>
              </div>
            );
          })}
        </div>
      </div>

      <button type="button" onClick={onRefresh} disabled={loading} className="status-map-refresh">
        {loading ? "Loading…" : "Reload statuses"}
      </button>
    </div>
  );
}
