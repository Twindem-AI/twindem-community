import { useState } from "react";
import type { GitHubAccountRepo, GitRepoInspection } from "../../shared/domain";

export type RepoValue = { owner: string; name: string };

// Self-contained GitHub repo picker: Adopt (inspect a folder) / Browse (account repos) / Create.
// Plus an explicit Link & push when a repo is set and a local folder (adoptPath) is given.
// Talks to window.tandem.github directly so callers don't plumb owners/repos state.
export function RepoField({
  value,
  adoptPath,
  onChange,
  onNotice
}: {
  value?: RepoValue;
  adoptPath?: string; // absolute local folder for Adopt + Link & push
  onChange: (next: RepoValue | undefined) => void;
  onNotice?: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [owners, setOwners] = useState<string[]>([]);
  const [owner, setOwner] = useState("");
  const [repos, setRepos] = useState<GitHubAccountRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadOwners = async () => {
    const r = await window.tandem.github.listProjectOwners().catch(() => null);
    if (r?.ok) {
      const logins = r.data.map((o) => o.login);
      setOwners(logins);
      if (!owner && logins[0]) setOwner(logins[0]);
    }
  };

  const expand = async () => {
    setOpen(true);
    setError(null);
    if (owners.length === 0) await loadOwners();
  };

  const loadRepos = async (forOwner: string) => {
    setLoading(true);
    setError(null);
    const r = await window.tandem.github.listRepos(forOwner).catch(() => null);
    setLoading(false);
    if (r?.ok) setRepos(r.data);
    else setError(r && !r.ok ? r.error.message : "Couldn't list repos. Is gh logged in?");
  };

  const adopt = async () => {
    if (!adoptPath) return;
    setBusy(true);
    setError(null);
    const r = await window.tandem.github.inspectGitRepo(adoptPath).catch(() => null);
    setBusy(false);
    const data = r?.ok ? (r.data as GitRepoInspection) : null;
    if (data?.status === "github_origin" && data.owner && data.name) {
      onChange({ owner: data.owner, name: data.name });
      onNotice?.(`Adopted ${data.owner}/${data.name} (already linked).`);
      setOpen(false);
    } else if (data?.status === "other_origin") {
      setError(`This folder has a non-GitHub remote (${data.originUrl}).`);
    } else {
      setError("This folder isn't a GitHub repo yet — use Browse or Create.");
    }
  };

  const create = async () => {
    if (!owner || !newName.trim()) return;
    setCreating(true);
    setError(null);
    const r = await window.tandem.github.createRepo(owner, newName.trim(), true).catch(() => null);
    setCreating(false);
    if (r?.ok) {
      onChange({ owner: r.data.owner, name: r.data.name });
      onNotice?.(`Created ${r.data.nameWithOwner} (configured — link & push when ready).`);
      setNewName("");
      setOpen(false);
    } else {
      setError(r && !r.ok ? r.error.message : "Create failed.");
    }
  };

  const linkAndPush = async () => {
    if (!adoptPath || !value) return;
    setBusy(true);
    setError(null);
    try {
      const link = await window.tandem.github.linkRemote(adoptPath, value.owner, value.name);
      if (!link.ok) throw new Error(link.error.message);
      const status = await window.tandem.github.gitStatusShort(adoptPath).catch(() => null);
      const preview = status?.ok ? status.data : "";
      const ok = window.confirm(
        `Link & push to ${value.owner}/${value.name}?\n\nFiles in the initial commit (.twindem/ excluded):\n${preview || "(clean / nothing to commit)"}\n\nThis runs: git add -A, commit, push.`
      );
      if (!ok) {
        onNotice?.("Remote linked. Push skipped.");
        setBusy(false);
        return;
      }
      const push = await window.tandem.github.initialPush(adoptPath);
      if (!push.ok) throw new Error(push.error.message);
      onNotice?.(`Linked & pushed ${value.owner}/${value.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="repo-field">
      <div className="repo-field-current">
        <span className="repo-field-value">{value ? `${value.owner}/${value.name}` : "(no repo — part of principal/monorepo)"}</span>
        {value && (
          <>
            {adoptPath && (
              <button type="button" onClick={() => void linkAndPush()} disabled={busy} title="Link this folder to the remote and push">
                {busy ? "…" : "Link & push"}
              </button>
            )}
            <button type="button" onClick={() => onChange(undefined)} disabled={busy}>Clear</button>
          </>
        )}
        <button type="button" onClick={() => (open ? setOpen(false) : void expand())}>{open ? "Close" : value ? "Change" : "Set repo"}</button>
      </div>
      {open && (
        <div className="repo-field-panel">
          {adoptPath && (
            <button type="button" className="repo-field-adopt" onClick={() => void adopt()} disabled={busy}>
              Adopt this folder's repo
            </button>
          )}
          <label className="repo-field-owner">
            Owner
            <select
              value={owner}
              onChange={(e) => {
                setOwner(e.target.value);
                void loadRepos(e.target.value);
              }}
            >
              {owners.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
            <button type="button" onClick={() => void loadRepos(owner)} disabled={!owner || loading}>
              {loading ? "Loading…" : "Browse repos"}
            </button>
          </label>
          {repos.length > 0 && (
            <select
              className="repo-field-list"
              value=""
              onChange={(e) => {
                const repo = repos.find((r) => r.nameWithOwner === e.target.value);
                if (repo) {
                  onChange({ owner: repo.owner, name: repo.name });
                  setOpen(false);
                }
              }}
            >
              <option value="">Choose a repo…</option>
              {repos.map((r) => (
                <option key={r.nameWithOwner} value={r.nameWithOwner}>{r.nameWithOwner}{r.isPrivate ? " (private)" : ""}</option>
              ))}
            </select>
          )}
          <div className="repo-field-create">
            <input placeholder="new-repo-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button type="button" onClick={() => void create()} disabled={!owner || !newName.trim() || creating}>
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
          {error && <p className="repo-field-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
