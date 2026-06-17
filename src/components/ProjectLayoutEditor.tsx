import { RepoField, type RepoValue } from "./RepoField";

export type ProjectLayoutEntry = { label: string; path: string; repo?: RepoValue };

// Repeatable rows describing where parts of the project live (mono/poly/mixed). Folder is chosen via a
// native picker (created on the spot, validated under the project root in main). Each row optionally has
// its own GitHub repo (polyrepo) via RepoField.
export function ProjectLayoutEditor({
  value,
  onChange,
  root,
  onNotice
}: {
  value: ProjectLayoutEntry[];
  onChange: (next: ProjectLayoutEntry[]) => void;
  root?: string;
  onNotice?: (msg: string) => void;
}) {
  const rows = value;
  const update = (index: number, patch: Partial<ProjectLayoutEntry>) =>
    onChange(rows.map((row, idx) => (idx === index ? { ...row, ...patch } : row)));
  const add = () => onChange([...rows, { label: "", path: "" }]);
  const remove = (index: number) => onChange(rows.filter((_, idx) => idx !== index));

  const browseFolder = async (index: number) => {
    if (!root?.trim()) {
      onNotice?.("Set the project folder first.");
      return;
    }
    const r = await window.tandem.config.pickWorkspaceSubdirectory(root.trim()).catch(() => null);
    if (r?.ok && r.data) update(index, { path: r.data.relativePath });
    else if (r && !r.ok) onNotice?.(r.error.message);
  };

  const absPath = (path: string): string | undefined => {
    const p = path.trim().replace(/^\.?\/+/, "");
    if (!root?.trim() || !p) return undefined;
    return `${root.trim().replace(/\/+$/, "")}/${p}`;
  };

  return (
    <div className="project-layout-editor">
      {rows.map((row, index) => (
        <div className="project-layout-row2" key={index}>
          <div className="project-layout-line">
            <input
              placeholder="Component (e.g. Backend)"
              value={row.label}
              onChange={(event) => update(index, { label: event.target.value })}
            />
            <span className="project-layout-arrow" aria-hidden>→</span>
            <input
              className="project-layout-path"
              placeholder="folder (Browse)"
              value={row.path}
              onChange={(event) => update(index, { path: event.target.value })}
            />
            <button type="button" onClick={() => void browseFolder(index)}>Browse</button>
            <button type="button" className="project-layout-remove" aria-label="Remove component" onClick={() => remove(index)}>✕</button>
          </div>
          <RepoField
            value={row.repo}
            adoptPath={absPath(row.path)}
            onChange={(repo) => update(index, { repo })}
            onNotice={onNotice}
          />
        </div>
      ))}
      <button type="button" className="project-layout-add" onClick={add}>+ Add component</button>
    </div>
  );
}
