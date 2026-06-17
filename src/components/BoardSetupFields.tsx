import { useState } from "react";
import type {
  GitHubAuthStatus,
  GitHubProjectOption,
  GitHubProjectOwnerOption,
  JiraProjectOption
} from "../../shared/domain";
import { boardCapabilities } from "../../shared/config";
import { ProjectPicker, JiraProjectPicker } from "./ProjectPicker";
import { BoardHelpLinks, type BoardHelpTopic } from "./BoardHelpLinks";

export type BoardTypeChoice = "github" | "jira" | "none";

// The board-provider fields shared by Onboarding and Settings. Repo/code config (allowed paths) is
// NOT here — it lives in the separate Code/Repo step. `issueRepository` IS here because it is GitHub
// *board* config (where issues are filed), rendered only under the GitHub tab.
export type BoardSetupValue = {
  boardType: BoardTypeChoice;
  boardSetupMode: "existing" | "create";
  githubOwner: string;
  projectNumber: string;
  issueRepository: string;
  newBoardTitle: string;
  jiraSiteUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
  jiraProjectKey: string;
  jiraIssueType: string;
};

export type GitHubBoardHandlers = {
  projects: GitHubProjectOption[];
  owners: GitHubProjectOwnerOption[];
  loading: boolean;
  creating: boolean;
  checking: boolean;
  check: GitHubAuthStatus | null;
  onConnect: () => void;
  onRefresh: () => void;
  onCreateProject: () => void;
};

export type JiraBoardHandlers = {
  projects: JiraProjectOption[];
  loading: boolean;
  creating: boolean;
  authChecking: boolean;
  authed: boolean;
  check: GitHubAuthStatus | null;
  tokenSavedHint?: boolean;
  onAuthenticate: () => void;
  onRefreshProjects: () => void;
  onCreateProject: (key: string, name: string) => void;
};

const BOARD_TABS: Array<{ value: BoardTypeChoice; label: string }> = [
  { value: "none", label: "No board" },
  { value: "jira", label: "Jira" },
  { value: "github", label: "GitHub" }
];

function BoardTypeTabs({ value, onChange }: { value: BoardTypeChoice; onChange: (next: BoardTypeChoice) => void }) {
  return (
    <div className="board-type-tabs" role="tablist" aria-label="Board type">
      {BOARD_TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          className={value === tab.value ? "active" : ""}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function BoardSetupFields({
  value,
  onChange,
  github,
  jira,
  helpTopic,
  onHelpTopicChange,
  workspaceName
}: {
  value: BoardSetupValue;
  onChange: (patch: Partial<BoardSetupValue>) => void;
  github: GitHubBoardHandlers;
  jira: JiraBoardHandlers;
  helpTopic: BoardHelpTopic;
  onHelpTopicChange: (topic: BoardHelpTopic) => void;
  workspaceName?: string;
}) {
  const providerForHelp: "github_project" | "jira" | "none" =
    value.boardType === "github" ? "github_project" : value.boardType;

  // Inline "new Jira project" form state (local to this component — never persisted).
  const [showNewJira, setShowNewJira] = useState(false);
  const [newJiraKey, setNewJiraKey] = useState("");
  const [newJiraName, setNewJiraName] = useState("");

  return (
    <div className="board-setup">
      <div className="board-setup-head">
        <span className="field-label">Board type</span>
        <BoardTypeTabs value={value.boardType} onChange={(boardType) => onChange({ boardType })} />
      </div>
      <div className="board-setup-body">
        <div className="board-setup-fields">
      {value.boardType === "github" && (
        <>
          <label>
            Project mode
            <select
              value={value.boardSetupMode}
              onChange={(event) => onChange({ boardSetupMode: event.target.value as "existing" | "create" })}
            >
              <option value="existing">Use existing Project</option>
              <option value="create">Create new Project</option>
            </select>
          </label>
          <ProjectPicker
            projects={github.projects}
            owner={value.githubOwner}
            projectNumber={Number(value.projectNumber) || undefined}
            disabled={value.boardSetupMode === "create"}
            loading={github.loading}
            onRefresh={github.onRefresh}
            onSelect={(project) =>
              onChange({
                githubOwner: project?.owner ?? "",
                projectNumber: project ? String(project.number) : ""
              })
            }
          />
          <label>
            Tracking issue repository (GitHub)
            <input
              value={value.issueRepository}
              onChange={(event) => onChange({ issueRepository: event.target.value })}
              placeholder={value.githubOwner ? `${value.githubOwner}/repo-name` : "owner/repo, optional for local-only"}
            />
            <small className="field-hint">
              Where GitHub issues are filed. This is not the implementation repo unless you choose to use it that way. Leave empty if
              this project is local-only for now.
            </small>
          </label>
          {value.boardSetupMode === "create" && (
            <div className="settings-grid board-create-grid">
              <label>
                Owner
                {github.owners.length > 0 ? (
                  <select value={value.githubOwner || github.owners[0]?.login || ""} onChange={(event) => onChange({ githubOwner: event.target.value })}>
                    {github.owners.map((owner) => (
                      <option key={owner.login} value={owner.login}>
                        {owner.login} ({owner.type})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={value.githubOwner} onChange={(event) => onChange({ githubOwner: event.target.value })} placeholder="@me or organization owner" />
                )}
              </label>
              <label>
                Project title
                <input value={value.newBoardTitle} onChange={(event) => onChange({ newBoardTitle: event.target.value })} placeholder={workspaceName || "Twindem delivery"} />
              </label>
              <div className="setup-check-row">
                <button onClick={github.onCreateProject} disabled={github.creating}>
                  {github.creating ? "Creating..." : "Create Project"}
                </button>
                {Number(value.projectNumber) ? <span className="check-ok">Created #{value.projectNumber}</span> : null}
              </div>
            </div>
          )}
          <div className="setup-check-row">
            <button className="primary" onClick={github.onConnect} disabled={github.checking}>
              {github.checking ? "Checking..." : "Connect GitHub CLI"}
            </button>
            {github.check && <span className={github.check.ok ? "check-ok" : "check-bad"}>{github.check.message}</span>}
          </div>
        </>
      )}

      {value.boardType === "jira" && (
        <>
          <label>
            Jira site URL
            <input value={value.jiraSiteUrl} onChange={(event) => onChange({ jiraSiteUrl: event.target.value })} placeholder="https://your-domain.atlassian.net" />
          </label>
          <label>
            Jira account email
            <input value={value.jiraEmail} onChange={(event) => onChange({ jiraEmail: event.target.value })} placeholder="you@company.com" />
          </label>
          <label>
            Jira API token
            <input
              value={value.jiraApiToken}
              onChange={(event) => onChange({ jiraApiToken: event.target.value })}
              type="password"
              placeholder={jira.tokenSavedHint ? "Saved token exists; paste a new one to replace" : "Paste API token"}
            />
            <small className="field-hint">Stored with Electron safeStorage, not plaintext config.</small>
          </label>
          <div className="setup-check-row">
            <button className="primary" onClick={jira.onAuthenticate} disabled={jira.authChecking}>
              {jira.authChecking ? "Authenticating..." : "Authenticate"}
            </button>
            {jira.check && <span className={jira.check.ok ? "check-ok" : "check-bad"}>{jira.check.message}</span>}
          </div>

          {jira.authed && (
            <>
              <JiraProjectPicker
                projects={jira.projects}
                selectedKey={value.jiraProjectKey || undefined}
                loading={jira.loading}
                onRefresh={jira.onRefreshProjects}
                onSelect={(project) => onChange({ jiraProjectKey: project?.key ?? "" })}
              />
              {showNewJira ? (
                <div className="jira-create-grid">
                  <label>
                    New project name
                    <input
                      value={newJiraName}
                      onChange={(event) => {
                        const name = event.target.value;
                        setNewJiraName(name);
                        if (!newJiraKey) {
                          const suggested = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10);
                          if (suggested) setNewJiraKey(suggested);
                        }
                      }}
                      placeholder="Payments Service"
                    />
                  </label>
                  <label>
                    Project key
                    <input value={newJiraKey} onChange={(event) => setNewJiraKey(event.target.value.toUpperCase())} placeholder="PAY" />
                    <small className="field-hint">2–10 chars: a letter then letters/digits.</small>
                  </label>
                  <div className="setup-check-row">
                    <button
                      onClick={() => jira.onCreateProject(newJiraKey.trim(), newJiraName.trim())}
                      disabled={jira.creating || !newJiraKey.trim() || !newJiraName.trim()}
                    >
                      {jira.creating ? "Creating..." : "Create project"}
                    </button>
                    <button onClick={() => setShowNewJira(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="setup-check-row">
                  <button onClick={() => setShowNewJira(true)}>+ New project</button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {value.boardType === "none" && (
        <div className="auth-card">
          <div>
            <strong>No external board</strong>
            <p>Twindem keeps sessions local until you connect GitHub Project or Jira.</p>
          </div>
        </div>
      )}
      <div className="board-capabilities">
        <small>What Twindem can do with this board</small>
        <ul>
          {boardCapabilities(providerForHelp).map((cap) => (
            <li key={cap.label} className={cap.supported ? "cap-yes" : "cap-no"}>
              <span aria-hidden>{cap.supported ? "✓" : "—"}</span> {cap.label}
            </li>
          ))}
        </ul>
      </div>
        </div>
        <BoardHelpLinks topic={helpTopic} onTopicChange={onHelpTopicChange} activeProvider={providerForHelp} />
      </div>
    </div>
  );
}
