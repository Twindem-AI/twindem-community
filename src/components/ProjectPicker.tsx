import type { GitHubProjectOption } from "../../shared/domain";

// Stable select value for a GitHub Project (owner + number). Exported so callers that pre-seed an
// owner/number can match the option.
export function githubProjectValue(owner: string, projectNumber: number): string {
  return `${owner}::${projectNumber}`;
}

export function ProjectPicker({
  projects,
  owner,
  projectNumber,
  disabled,
  loading,
  onRefresh,
  onSelect
}: {
  projects: GitHubProjectOption[];
  owner?: string;
  projectNumber?: number;
  disabled?: boolean;
  loading?: boolean;
  onRefresh: () => void;
  onSelect: (project: Pick<GitHubProjectOption, "owner" | "number"> | null) => void;
}) {
  const currentValue = owner && projectNumber ? githubProjectValue(owner, projectNumber) : "";
  const hasCurrentOption = projects.some((project) => githubProjectValue(project.owner, project.number) === currentValue);
  const visibleProjects = projects.filter((project) => !project.closed);

  function select(value: string) {
    if (!value) {
      onSelect(null);
      return;
    }
    const project = projects.find((candidate) => githubProjectValue(candidate.owner, candidate.number) === value);
    if (project) onSelect({ owner: project.owner, number: project.number });
  }

  return (
    <div className="project-picker">
      <label>
        GitHub Project
        <select value={currentValue} disabled={disabled || visibleProjects.length === 0} onChange={(event) => select(event.target.value)}>
          <option value="">Choose a project</option>
          {currentValue && !hasCurrentOption && (
            <option value={currentValue}>
              {owner} / Project #{projectNumber}
            </option>
          )}
          {visibleProjects.map((project) => (
            <option key={project.id} value={githubProjectValue(project.owner, project.number)}>
              {project.owner} / {project.title}
            </option>
          ))}
        </select>
      </label>
      <button onClick={onRefresh} disabled={disabled || loading}>
        {loading ? "Loading..." : "Refresh projects"}
      </button>
    </div>
  );
}

// Jira sibling of ProjectPicker: same shape over JiraProjectOption[]. Value is the project key.
export function JiraProjectPicker({
  projects,
  selectedKey,
  disabled,
  loading,
  onRefresh,
  onSelect
}: {
  projects: import("../../shared/domain").JiraProjectOption[];
  selectedKey?: string;
  disabled?: boolean;
  loading?: boolean;
  onRefresh: () => void;
  onSelect: (project: import("../../shared/domain").JiraProjectOption | null) => void;
}) {
  const hasCurrentOption = projects.some((project) => project.key === selectedKey);
  function select(value: string) {
    if (!value) {
      onSelect(null);
      return;
    }
    const project = projects.find((candidate) => candidate.key === value);
    if (project) onSelect(project);
  }
  return (
    <div className="project-picker">
      <label>
        Jira project
        <select value={selectedKey ?? ""} disabled={disabled || projects.length === 0} onChange={(event) => select(event.target.value)}>
          <option value="">Choose a project</option>
          {selectedKey && !hasCurrentOption && <option value={selectedKey}>{selectedKey}</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.key}>
              {project.name} ({project.key})
            </option>
          ))}
        </select>
      </label>
      <button onClick={onRefresh} disabled={disabled || loading}>
        {loading ? "Loading..." : "Refresh projects"}
      </button>
    </div>
  );
}
