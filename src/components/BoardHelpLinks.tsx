export type BoardHelpTopic = "jira-token" | "github-board" | null;

// Help links + toggle panel for the board setup. `activeProvider` lets callers show only the link
// relevant to the current tab (e.g. just the Jira-token help on the Jira tab).
export function BoardHelpLinks({
  topic,
  onTopicChange,
  activeProvider
}: {
  topic: BoardHelpTopic;
  onTopicChange: (topic: BoardHelpTopic) => void;
  activeProvider?: "github_project" | "jira" | "none";
}) {
  const showJira = activeProvider === undefined || activeProvider === "jira";
  const showGithub = activeProvider === undefined || activeProvider === "github_project";
  return (
    <div className="board-help full">
      <div className="board-help-links">
        {showJira && (
          <button type="button" onClick={() => onTopicChange(topic === "jira-token" ? null : "jira-token")}>
            Where can I create Jira API Token?
          </button>
        )}
        {showGithub && (
          <button type="button" onClick={() => onTopicChange(topic === "github-board" ? null : "github-board")}>
            How can I connect with GitHub Board?
          </button>
        )}
        {activeProvider === "none" && <span className="board-help-note">No board — sessions stay local until you connect one.</span>}
      </div>
      {topic && (showJira || showGithub) && (
        <div className="board-help-panel">
          {topic === "jira-token" ? (
            <>
              <strong>Jira API token</strong>
              <p>Create it from your Atlassian account security page, using the same email you enter here.</p>
              <ol>
                <li>Open id.atlassian.com/manage-profile/security/api-tokens.</li>
                <li>Create an API token, for example named “Twindem local”.</li>
                <li>Paste the token here once; Twindem stores it encrypted with Electron safeStorage.</li>
              </ol>
              <a href="https://id.atlassian.com/manage-profile/security/api-tokens">Open Atlassian API tokens</a>
            </>
          ) : (
            <>
              <strong>GitHub Project board</strong>
              <p>Twindem uses your local GitHub CLI session and a GitHub Project as the board.</p>
              <ol>
                <li>Install and authenticate GitHub CLI with gh auth login.</li>
                <li>Click Connect GitHub CLI so Twindem can list your Projects.</li>
                <li>Select an existing Project or create a new one; the issue repository can stay empty for local-only Project draft items.</li>
              </ol>
              <a href="https://cli.github.com/manual/gh_auth_login">Open GitHub CLI auth docs</a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
