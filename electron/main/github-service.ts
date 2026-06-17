import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  BoardArtifactOption,
  GitHubAccountRepo,
  GitHubIssueContext,
  GitHubProjectOption,
  GitHubProjectOwnerOption,
  GitHubRepoOption,
  GitRepoInspection
} from "../../shared/domain.js";

const execFileAsync = promisify(execFile);

type GhIssueResponse = {
  number: number;
  title: string;
  body?: string;
  state: string;
  url: string;
  labels?: Array<{ name: string }>;
  comments?: Array<{
    author?: { login?: string };
    body: string;
    createdAt: string;
    url?: string;
  }>;
  projectItems?: Array<{
    status?: { name?: string };
  }>;
  closedByPullRequestsReferences?: Array<{
    number: number;
    title: string;
    url: string;
    state: string;
  }>;
};

type ProjectFieldValueSnapshot = {
  projectId: string;
  itemId: string;
  fields: Record<string, string>;
  singleSelectFields: Array<{
    id: string;
    name: string;
    options: Array<{ id: string; name: string }>;
  }>;
};

const TWINDEM_PROJECT_STATUS_OPTIONS = [
  { name: "Inbox", color: "GRAY", description: "New idea, task, or bug awaiting triage." },
  { name: "Planning", color: "YELLOW", description: "Refinement and technical planning." },
  { name: "In Progress", color: "BLUE", description: "Implementation is underway." },
  { name: "Review", color: "PURPLE", description: "Plan or implementation review." },
  { name: "UAT", color: "ORANGE", description: "Deployed for testing and validation." },
  { name: "Done", color: "GREEN", description: "Completed and accepted." },
  { name: "Wont Do", color: "RED", description: "Closed as canceled or not planned." }
] as const;

type GhUserResponse = {
  login: string;
};

type GhOrgResponse = Array<{
  login: string;
}>;

type GhLabelListResponse = Array<{
  name: string;
}>;

type GhProjectListResponse = {
  projects: Array<{
    id: string;
    number: number;
    title: string;
    url?: string;
    closed?: boolean;
    owner?: {
      login?: string;
      type?: string;
    };
  }>;
};

type GhProjectResponse = {
  id: string;
  number: number;
  title: string;
  url?: string;
  closed?: boolean;
  owner?: {
    login?: string;
    type?: string;
  };
};

type GhProjectItemListResponse = {
  items: Array<{
    id?: string;
    title?: string;
    status?: string;
    labels?: string[];
    repository?: string;
    content?: {
      id?: string;
      number?: number;
      repository?: string;
      title?: string;
      type?: string;
      url?: string;
    };
    number?: number;
    type?: string;
    url?: string;
  }>;
};

export class GitHubService {
  async authStatus(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.gh(["auth", "status"]);
      return { ok: true, message: "GitHub CLI is authenticated." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message: `${message}. Run "gh auth login" in your terminal, then retry in Twindem.`
      };
    }
  }

  async login(): Promise<{ ok: boolean; message: string }> {
    if (os.platform() !== "darwin") {
      return {
        ok: false,
        message: "Run \"gh auth login\" in your terminal, then click Connect GitHub CLI again."
      };
    }

    try {
      await execFileAsync("osascript", [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        'tell application "Terminal" to do script "gh auth login"'
      ]);
      return {
        ok: false,
        message: "Opened Terminal with \"gh auth login\". Finish the GitHub CLI login there, then click Connect GitHub CLI again."
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        message: `${message}. Run "gh auth login" in your terminal, then click Connect GitHub CLI again.`
      };
    }
  }

  async listProjects(): Promise<GitHubProjectOption[]> {
    const user = await this.ghJson<GhUserResponse>(["api", "user"]);
    const orgs = await this.ghJson<GhOrgResponse>(["api", "user/orgs"]);
    const owners = Array.from(new Set([user.login, ...orgs.map((org) => org.login)].filter(Boolean)));
    const projects: GitHubProjectOption[] = [];

    for (const owner of owners) {
      const response = await this.ghJson<GhProjectListResponse>([
        "project",
        "list",
        "--owner",
        owner,
        "--format",
        "json",
        "--limit",
        "100"
      ]);

      for (const project of response.projects ?? []) {
        projects.push({
          id: project.id,
          owner: project.owner?.login ?? owner,
          ownerType: project.owner?.type,
          number: project.number,
          title: project.title,
          url: project.url,
          closed: project.closed
        });
      }
    }

    return projects.sort((a, b) => {
      if (a.owner !== b.owner) return a.owner.localeCompare(b.owner);
      return a.number - b.number;
    });
  }

  async listProjectOwners(): Promise<GitHubProjectOwnerOption[]> {
    const user = await this.ghJson<GhUserResponse>(["api", "user"]);
    const orgs = await this.ghJson<GhOrgResponse>(["api", "user/orgs"]);
    return [
      { login: user.login, type: "User" },
      ...orgs.map((org) => ({ login: org.login, type: "Organization" }))
    ];
  }

  async createProject(owner: string, title: string): Promise<GitHubProjectOption> {
    const rawOwner = owner.trim() || "@me";
    const normalizedOwner = rawOwner.startsWith("@") && rawOwner !== "@me" ? rawOwner.slice(1) : rawOwner;
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error("Project title is required.");
    const project = await this.ghJson<GhProjectResponse>([
      "project",
      "create",
      "--owner",
      normalizedOwner,
      "--title",
      normalizedTitle,
      "--format",
      "json"
    ]);
    const user = normalizedOwner === "@me" && !project.owner?.login ? await this.ghJson<GhUserResponse>(["api", "user"]) : null;
    const option = {
      id: project.id,
      owner: project.owner?.login ?? user?.login ?? normalizedOwner,
      ownerType: project.owner?.type,
      number: project.number,
      title: project.title,
      url: project.url,
      closed: project.closed
    };
    await this.provisionTwindemStatusField(option.owner, option.number);
    return option;
  }

  async listProjectIssues(owner: string, projectNumber: number): Promise<BoardArtifactOption[]> {
    const response = await this.ghJson<GhProjectItemListResponse>([
      "project",
      "item-list",
      String(projectNumber),
      "--owner",
      owner,
      "--format",
      "json",
      "--limit",
      "200"
    ]);
    const issues: BoardArtifactOption[] = [];
    for (const item of response.items ?? []) {
      const content = item.content ?? {};
      const type = content.type ?? item.type;
      const issueNumber = content.number ?? item.number;
      const repo = projectItemRepo(content.repository ?? item.repository);
      const url = content.url ?? item.url;
      const title = content.title ?? item.title;
      if (type === "DraftIssue" || type === "Draft") {
        if (!title) continue;
        issues.push({
          id: item.id ?? content.id ?? String(title),
          provider: "github_project",
          kind: "github_draft",
          type: "Draft",
          key: item.id ?? content.id ?? String(title),
          title,
          url,
          status: item.status,
          labels: []
        });
        continue;
      }
      if (type !== "Issue" || !repo || !issueNumber || !url || !title) continue;
      issues.push({
        id: item.id ?? `${repo}#${issueNumber}`,
        provider: "github_project",
        kind: "github_issue",
        type: "Issue",
        key: `${repo}#${issueNumber}`,
        repo,
        issueNumber,
        title,
        url,
        status: item.status,
        labels: Array.isArray(item.labels) ? item.labels : []
      });
    }
    return issues.sort((a, b) => {
      const statusCompare = (a.status ?? "").localeCompare(b.status ?? "");
      if (statusCompare !== 0) return statusCompare;
      return (b.issueNumber ?? 0) - (a.issueNumber ?? 0);
    });
  }

  async createDraftIssue(owner: string, projectNumber: number, title: string, body: string): Promise<{
    id: string;
    title: string;
    body: string;
    url?: string;
    status?: string;
    fetchedAt: string;
  }> {
    const created = await this.ghJson<Record<string, unknown>>([
      "project",
      "item-create",
      String(projectNumber),
      "--owner",
      owner,
      "--title",
      title,
      "--body",
      body,
      "--format",
      "json"
    ]);
    const id = String(created.id ?? record(created.item).id ?? "");
    if (!id) throw new Error("GitHub did not return a Project draft item id.");
    return {
      id,
      title: String(created.title ?? title),
      body,
      url: typeof created.url === "string" ? created.url : undefined,
      fetchedAt: new Date().toISOString()
    };
  }

  async listWorkspaceRepos(workspaceRoot: string): Promise<GitHubRepoOption[]> {
    const root = workspaceRoot.trim();
    if (!root || !existsSync(root)) return [];

    const candidatePaths = new Set<string>();
    const scan = async (dir: string, depth: number) => {
      if (existsSync(join(dir, ".git"))) {
        candidatePaths.add(dir);
        return;
      }
      if (depth <= 0) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        await scan(join(dir, entry.name), depth - 1);
      }
    };
    await scan(root, 2);

    const repos: GitHubRepoOption[] = [];
    for (const path of candidatePaths) {
      try {
        const { stdout } = await execFileAsync("git", ["-C", path, "remote", "get-url", "origin"], {
          env: { ...process.env, PATH: expandedPath() }
        });
        const parsed = parseGithubRepo(stdout.trim());
        if (parsed) repos.push({ ...parsed, path });
      } catch {
        // Local repositories without a GitHub origin are intentionally skipped.
      }
    }

    return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  // Browse the user's / org's GitHub repos. Owner discovery is done by the caller (reuse
  // listProjectOwners); `--limit` so org repos aren't truncated by the default page.
  async listAccountRepos(owner: string, limit = 100): Promise<GitHubAccountRepo[]> {
    const rawOwner = owner.trim();
    const target = !rawOwner || rawOwner === "@me" ? [] : [rawOwner];
    const rows = await this.ghJson<Array<{ name: string; nameWithOwner: string; isPrivate: boolean; url: string; owner?: { login?: string } }>>([
      "repo",
      "list",
      ...target,
      "--limit",
      String(limit),
      "--json",
      "name,nameWithOwner,isPrivate,url,owner"
    ]);
    return rows.map((r) => ({
      owner: r.owner?.login ?? r.nameWithOwner.split("/")[0],
      name: r.name,
      nameWithOwner: r.nameWithOwner,
      isPrivate: Boolean(r.isPrivate),
      url: r.url
    }));
  }

  // Create-only: makes the empty GitHub repo, records nothing locally (no init/push). State = configured.
  async createRepo(owner: string, name: string, isPrivate = true): Promise<GitHubAccountRepo> {
    const ownerPart = owner.trim() && owner.trim() !== "@me" ? `${owner.trim()}/` : "";
    const repoArg = `${ownerPart}${name.trim()}`;
    if (!name.trim()) throw new Error("Repository name is required.");
    await this.gh(["repo", "create", repoArg, isPrivate ? "--private" : "--public"]);
    // Resolve the canonical owner/name back.
    const view = await this.ghJson<{ name: string; nameWithOwner: string; isPrivate: boolean; url: string; owner?: { login?: string } }>([
      "repo",
      "view",
      repoArg,
      "--json",
      "name,nameWithOwner,isPrivate,url,owner"
    ]);
    return {
      owner: view.owner?.login ?? view.nameWithOwner.split("/")[0],
      name: view.name,
      nameWithOwner: view.nameWithOwner,
      isPrivate: Boolean(view.isPrivate),
      url: view.url
    };
  }

  // The local git state of a folder — drives configured/linked/mismatch.
  async inspectGitRepo(path: string): Promise<GitRepoInspection> {
    const trimmed = path.trim();
    if (!trimmed || !existsSync(trimmed) || !existsSync(join(trimmed, ".git"))) {
      return { hasGit: false, hasOrigin: false, isGitHub: false, status: existsSync(trimmed) ? "none" : "none" };
    }
    let originUrl: string;
    try {
      const { stdout } = await execFileAsync("git", ["-C", trimmed, "remote", "get-url", "origin"], {
        env: { ...process.env, PATH: expandedPath() }
      });
      originUrl = stdout.trim();
    } catch {
      return { hasGit: true, hasOrigin: false, isGitHub: false, status: "local_no_origin" };
    }
    const parsed = parseGithubRepo(originUrl);
    if (parsed) {
      return { hasGit: true, hasOrigin: true, isGitHub: true, owner: parsed.owner, name: parsed.name, status: "github_origin", originUrl };
    }
    return { hasGit: true, hasOrigin: true, isGitHub: false, status: "other_origin", originUrl };
  }

  // Link a local folder to a GitHub remote — preflighted, no commit/push. Stops on a different origin.
  async linkRemote(path: string, owner: string, name: string): Promise<void> {
    const dir = path.trim();
    if (!dir || !existsSync(dir)) throw new Error(`Folder does not exist: ${dir}`);
    const wantUrl = `https://github.com/${owner}/${name}.git`;
    const state = await this.inspectGitRepo(dir);
    if (state.hasOrigin) {
      if (state.isGitHub && state.owner === owner && state.name === name) return; // already linked
      throw new Error(`This folder already has a different remote (${state.originUrl}). Refusing to overwrite.`);
    }
    if (!state.hasGit) {
      await execFileAsync("git", ["-C", dir, "init"], { env: { ...process.env, PATH: expandedPath() } });
    }
    await execFileAsync("git", ["-C", dir, "remote", "add", "origin", wantUrl], { env: { ...process.env, PATH: expandedPath() } });
  }

  // `git status --short` for the push-preview UI.
  async gitStatusShort(path: string): Promise<string> {
    const dir = path.trim();
    if (!dir || !existsSync(join(dir, ".git"))) return "";
    const { stdout } = await execFileAsync("git", ["-C", dir, "status", "--short"], {
      env: { ...process.env, PATH: expandedPath() }
    });
    return stdout.trim();
  }

  // Initial commit + push. Ensures .twindem/ is ignored. Caller shows the preview + confirms first.
  async initialPush(path: string, message = "Initial commit (Twindem)"): Promise<void> {
    const dir = path.trim();
    if (!dir || !existsSync(join(dir, ".git"))) throw new Error("Folder is not linked yet — link the remote first.");
    const gitignore = join(dir, ".gitignore");
    const ignoreLine = ".twindem/";
    try {
      const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
      if (!current.split(/\r?\n/).some((l) => l.trim() === ignoreLine)) {
        writeFileSync(gitignore, `${current ? current.replace(/\n?$/, "\n") : ""}${ignoreLine}\n`);
      }
    } catch {
      /* best-effort */
    }
    const env = { ...process.env, PATH: expandedPath() };
    await execFileAsync("git", ["-C", dir, "add", "-A"], { env });
    await execFileAsync("git", ["-C", dir, "commit", "-m", message], { env }).catch(() => undefined);
    await execFileAsync("git", ["-C", dir, "push", "-u", "origin", "HEAD"], { env });
  }

  async viewIssue(repo: string, issueNumber: number): Promise<GitHubIssueContext> {
    const data = await this.ghJson<GhIssueResponse>([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "number,title,body,state,url,labels,comments,projectItems,closedByPullRequestsReferences"
    ]);
    return {
      repo,
      issueNumber: data.number,
      title: data.title,
      body: data.body ?? "",
      state: data.state,
      url: data.url,
      labels: (data.labels ?? []).map((label) => label.name),
      comments: (data.comments ?? []).map((comment) => ({
        author: comment.author?.login ?? "unknown",
        body: comment.body,
        createdAt: comment.createdAt,
        url: comment.url
      })),
      linkedPrs: (data.closedByPullRequestsReferences ?? []).map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state
      })),
      projectStatus: data.projectItems?.find((item) => item.status?.name)?.status?.name,
      projectFields: {
        Status: data.projectItems?.find((item) => item.status?.name)?.status?.name ?? data.state,
        State: data.state
      },
      fetchedAt: new Date().toISOString()
    };
  }

  async createIssue(
    repo: string,
    title: string,
    body: string,
    labels: string[] = []
  ): Promise<GitHubIssueContext> {
    await this.ensureLabels(repo, labels);
    const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body || "Created from Twindem."];
    for (const label of labels) args.push("--label", label);
    const url = (await this.gh(args)).trim();
    const issueNumber = this.issueNumberFromUrl(url);
    return this.viewIssue(repo, issueNumber);
  }

  async updateIssueBody(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.gh(["issue", "edit", String(issueNumber), "--repo", repo, "--body", body]);
  }

  async updateIssue(
    repo: string,
    issueNumber: number,
    input: { title?: string; body?: string; addLabels?: string[]; removeLabels?: string[] }
  ): Promise<GitHubIssueContext> {
    const args = ["issue", "edit", String(issueNumber), "--repo", repo];
    if (input.title !== undefined) args.push("--title", input.title);
    if (input.body !== undefined) args.push("--body", input.body);
    await this.ensureLabels(repo, input.addLabels ?? []);
    for (const label of input.addLabels ?? []) args.push("--add-label", label);
    for (const label of input.removeLabels ?? []) args.push("--remove-label", label);
    await this.gh(args);
    return this.viewIssue(repo, issueNumber);
  }

  async commentIssue(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.gh(["issue", "comment", String(issueNumber), "--repo", repo, "--body", body]);
  }

  async closeIssue(repo: string, issueNumber: number, commentBody?: string): Promise<void> {
    if (commentBody?.trim()) {
      await this.commentIssue(repo, issueNumber, commentBody.trim());
    }
    await this.gh(["issue", "close", String(issueNumber), "--repo", repo]);
  }

  async addIssueToProject(owner: string, projectNumber: number, issueUrl: string): Promise<boolean> {
    try {
      await this.gh([
        "project",
        "item-add",
        String(projectNumber),
        "--owner",
        owner,
        "--url",
        issueUrl,
        "--format",
        "json"
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async projectFieldSnapshot(
    owner: string,
    projectNumber: number,
    repo: string,
    issueNumber: number
  ): Promise<ProjectFieldValueSnapshot | null> {
    const [repoOwner, repoName] = repo.split("/");
    if (!repoOwner || !repoName) throw new Error(`Invalid repository: ${repo}`);
    let after: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const args = [
        "api",
        "graphql",
        "-f",
        "query=" + projectFieldsQuery("organization"),
        "-f",
        `owner=${owner}`,
        "-F",
        `number=${projectNumber}`,
        "-f",
        `repoOwner=${repoOwner}`,
        "-f",
        `repoName=${repoName}`,
        "-F",
        `issueNumber=${issueNumber}`
      ];
      if (after) args.push("-f", `after=${after}`);

      const response = await this.ghJsonWithUserFallback<Record<string, unknown>>(args, owner);
      const project = projectFromGraphql(response);
      if (!project) return null;
      const projectId = String(project.id ?? "");
      const singleSelectFields = singleSelectFieldsFromGraphql(project);
      const nodes = graphqlNodes(project.items);
      const item = nodes.find((candidate) => {
        const content = record(candidate.content);
        const repository = record(content.repository);
        return content.number === issueNumber && repository.nameWithOwner === repo && content.type !== "PullRequest";
      });
      if (item) {
        return {
          projectId,
          itemId: String(item.id),
          fields: fieldValuesFromGraphql(item),
          singleSelectFields
        };
      }
      const pageInfo = record(project.items).pageInfo;
      const hasNextPage = record(pageInfo).hasNextPage === true;
      const endCursor = record(pageInfo).endCursor;
      if (!hasNextPage || typeof endCursor !== "string") return null;
      after = endCursor;
    }

    return null;
  }

  async provisionTwindemStatusField(owner: string, projectNumber: number): Promise<void> {
    const project = await this.getProjectFields(owner, projectNumber);
    const projectId = String(project.id ?? "");
    const statusField =
      singleSelectFieldsFromGraphql(project).find((field) => field.name.trim().toLowerCase() === "status") ??
      null;
    if (statusField) {
      await this.ghJson<Record<string, unknown>>([
        "api",
        "graphql",
        "-f",
        "query=" + updateProjectStatusFieldMutation(),
        "-f",
        `fieldId=${statusField.id}`,
        ...statusOptionFieldArgs()
      ]);
      return;
    }
    await this.ghJson<Record<string, unknown>>([
      "api",
      "graphql",
      "-f",
      "query=" + createProjectStatusFieldMutation(),
      "-f",
      `projectId=${projectId}`,
      ...statusOptionFieldArgs()
    ]);
  }

  private async getProjectFields(owner: string, projectNumber: number): Promise<Record<string, unknown>> {
    const response = await this.ghJsonWithUserFallback<Record<string, unknown>>(
      [
        "api",
        "graphql",
        "-f",
        "query=" + projectFieldsOnlyQuery("organization"),
        "-f",
        `owner=${owner}`,
        "-F",
        `number=${projectNumber}`
      ],
      owner
    );
    const project = projectFromGraphql(response);
    if (!project) throw new Error(`Could not read GitHub Project ${owner} #${projectNumber}.`);
    return project;
  }

  async requestTaskReview(
    repo: string,
    issueNumber: number,
    requestedLabel: string,
    commentBody?: string
  ): Promise<void> {
    await this.editLabels(repo, issueNumber, { add: [requestedLabel] });
    await this.commentIssue(
      repo,
      issueNumber,
      commentBody?.trim() || `Task review requested.\n\n---\nAuthor: Twindem\nRole: Workflow`
    );
  }

  async applyTaskReviewVerdict(
    repo: string,
    issueNumber: number,
    verdict: "ok" | "changes" | "blocked",
    labels: { requested: string; ok: string; changes: string },
    commentBody?: string
  ): Promise<void> {
    if (verdict === "ok") {
      await this.editLabels(repo, issueNumber, {
        add: [labels.ok],
        remove: [labels.requested, labels.changes]
      });
      await this.commentIssue(
        repo,
        issueNumber,
        commentBody?.trim() || `Verdict: OK\n\n---\nAuthor: Twindem\nRole: Workflow`
      );
      return;
    }

    if (verdict === "changes") {
      await this.editLabels(repo, issueNumber, {
        add: [labels.changes],
        remove: [labels.requested, labels.ok]
      });
      await this.commentIssue(
        repo,
        issueNumber,
        commentBody?.trim() || `Verdict: Changes requested\n\n---\nAuthor: Twindem\nRole: Workflow`
      );
      return;
    }

    await this.commentIssue(
      repo,
      issueNumber,
      commentBody?.trim() ||
        `Verdict: Blocked\n\nTwindem marked this task as blocked. Add blocker details before continuing.\n\n---\nAuthor: Twindem\nRole: Workflow`
    );
  }

  async setProjectStatus(
    owner: string,
    projectNumber: number,
    repo: string,
    issueNumber: number,
    statusName: string | string[]
  ): Promise<boolean> {
    const snapshot = await this.projectFieldSnapshot(owner, projectNumber, repo, issueNumber);
    const statusField =
      snapshot?.singleSelectFields.find((field) => field.name.trim().toLowerCase() === "status") ??
      snapshot?.singleSelectFields[0];
    const wantedStatuses = (Array.isArray(statusName) ? statusName : [statusName])
      .map((status) => status.trim())
      .filter(Boolean);
    // Project status options often carry emoji/decoration (e.g. "📥 Inbox"), so match by substring.
    const option = wantedStatuses
      .map((wantedStatus) => {
        const wanted = wantedStatus.toLowerCase();
        return (
          statusField?.options.find((candidate) => candidate.name.trim().toLowerCase() === wanted) ??
          statusField?.options.find((candidate) => candidate.name.toLowerCase().includes(wanted))
        );
      })
      .find(Boolean);
    if (!snapshot || !statusField || !option) return false;

    await this.gh([
      "api",
      "graphql",
      "-f",
      "query=" + updateSingleSelectMutation(),
      "-f",
      `projectId=${snapshot.projectId}`,
      "-f",
      `itemId=${snapshot.itemId}`,
      "-f",
      `fieldId=${statusField.id}`,
      "-f",
      `optionId=${option.id}`
    ]);
    return true;
  }

  async setProjectItemStatus(owner: string, projectNumber: number, itemId: string, statusName: string | string[]): Promise<boolean> {
    const project = await this.getProjectFields(owner, projectNumber);
    const projectId = String(project.id ?? "");
    const statusField =
      singleSelectFieldsFromGraphql(project).find((field) => field.name.trim().toLowerCase() === "status") ??
      singleSelectFieldsFromGraphql(project)[0];
    const wantedStatuses = (Array.isArray(statusName) ? statusName : [statusName]).map((status) => status.trim()).filter(Boolean);
    const option = wantedStatuses
      .map((wantedStatus) => {
        const wanted = wantedStatus.toLowerCase();
        return (
          statusField?.options.find((candidate) => candidate.name.trim().toLowerCase() === wanted) ??
          statusField?.options.find((candidate) => candidate.name.toLowerCase().includes(wanted))
        );
      })
      .find(Boolean);
    if (!projectId || !statusField || !option) return false;
    await this.gh([
      "api",
      "graphql",
      "-f",
      "query=" + updateSingleSelectMutation(),
      "-f",
      `projectId=${projectId}`,
      "-f",
      `itemId=${itemId}`,
      "-f",
      `fieldId=${statusField.id}`,
      "-f",
      `optionId=${option.id}`
    ]);
    return true;
  }

  async removeIssueFromProject(owner: string, projectNumber: number, repo: string, issueNumber: number): Promise<boolean> {
    const snapshot = await this.projectFieldSnapshot(owner, projectNumber, repo, issueNumber);
    if (!snapshot) return false;
    await this.gh([
      "api",
      "graphql",
      "-f",
      "query=" + deleteProjectItemMutation(),
      "-f",
      `projectId=${snapshot.projectId}`,
      "-f",
      `itemId=${snapshot.itemId}`
    ]);
    return true;
  }

  async removeProjectItem(owner: string, projectNumber: number, itemId: string): Promise<boolean> {
    if (!itemId.trim()) return false;
    await this.gh([
      "project",
      "item-delete",
      String(projectNumber),
      "--owner",
      owner,
      "--id",
      itemId,
      "--format",
      "json"
    ]);
    return true;
  }

  private async editLabels(
    repo: string,
    issueNumber: number,
    changes: { add?: string[]; remove?: string[] }
  ): Promise<void> {
    const args = ["issue", "edit", String(issueNumber), "--repo", repo];
    for (const label of changes.add ?? []) args.push("--add-label", label);
    for (const label of changes.remove ?? []) args.push("--remove-label", label);
    await this.gh(args);
  }

  private async ensureLabels(repo: string, labels: string[]): Promise<void> {
    const wanted = Array.from(new Set(labels.map((label) => label.trim()).filter(Boolean)));
    if (wanted.length === 0) return;
    const existing = new Set(
      (await this.ghJson<GhLabelListResponse>(["label", "list", "--repo", repo, "--json", "name", "--limit", "200"]))
        .map((label) => label.name.toLowerCase())
    );
    for (const label of wanted) {
      if (existing.has(label.toLowerCase())) continue;
      const style = labelStyle(label);
      await this.gh([
        "label",
        "create",
        label,
        "--repo",
        repo,
        "--color",
        style.color,
        "--description",
        style.description
      ]).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists/i.test(message)) throw error;
      });
    }
  }

  private issueNumberFromUrl(url: string): number {
    const match = url.match(/\/issues\/(\d+)\s*$/);
    if (!match) throw new Error(`Could not read issue number from gh output: ${url}`);
    return Number(match[1]);
  }

  private async ghJson<T>(args: string[]): Promise<T> {
    const output = await this.gh(args);
    return JSON.parse(output) as T;
  }

  private async ghJsonWithUserFallback<T>(args: string[], owner: string): Promise<T> {
    try {
      return await this.ghJson<T>(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Could not resolve to an Organization")) throw error;
      const userArgs = args.map((arg) =>
        arg.startsWith("query=") ? `query=${projectFieldsQuery("user")}` : arg
      );
      try {
        return await this.ghJson<T>(userArgs);
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(`Could not read GitHub Project for ${owner}: ${fallbackMessage}`, { cause: fallbackError });
      }
    }
  }

  private async gh(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("gh", args, {
        env: { ...process.env, PATH: expandedPath() },
        maxBuffer: 10 * 1024 * 1024
      });
      return stdout;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`GitHub CLI failed: ${shortGhError(error.message)}`, { cause: error });
      }
      throw error;
    }
  }

}

function labelStyle(label: string): { color: string; description: string } {
  const normalized = label.toLowerCase();
  if (normalized === "architecture") return { color: "5319e7", description: "Architecture decision or ADR work." };
  if (normalized === "spike") return { color: "d93f0b", description: "Time-boxed technical exploration or proof of concept." };
  if (normalized === "research") return { color: "0e8a16", description: "Research, discovery, comparison, or spike." };
  if (normalized === "runbook") return { color: "fbca04", description: "Operational procedure or checklist." };
  if (normalized === "feature") return { color: "1d76db", description: "Feature implementation work." };
  if (normalized === "bug") return { color: "d73a4a", description: "Defect repair or regression work." };
  return { color: "ededed", description: "Created by Twindem." };
}

function shortGhError(message: string): string {
  const ghLine = message.match(/gh:\s*([^\n]+)/i);
  if (ghLine?.[1]) return ghLine[1].trim();
  const firstLine = message.split("\n").find((line) => !line.includes("gh api graphql"))?.trim();
  return firstLine || "Command failed. Check GitHub CLI authentication and project access.";
}

function expandedPath(): string {
  const standardPaths = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ];
  return Array.from(new Set([...(process.env.PATH ?? "").split(":").filter(Boolean), ...standardPaths])).join(":");
}

function projectFieldsQuery(ownerKind: "organization" | "user"): string {
  return `query($owner:String!, $number:Int!, $after:String) {
    ${ownerKind}(login:$owner) {
      projectV2(number:$number) {
        id
        fields(first:50) {
          nodes {
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          }
        }
        items(first:100, after:$after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            content { ... on Issue { number repository { nameWithOwner } } }
            fieldValues(first:50) {
              nodes {
                ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } }
              }
            }
          }
        }
      }
    }
  }`;
}

function projectFieldsOnlyQuery(ownerKind: "organization" | "user"): string {
  return `query($owner:String!, $number:Int!) {
    ${ownerKind}(login:$owner) {
      projectV2(number:$number) {
        id
        fields(first:50) {
          nodes {
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          }
        }
      }
    }
  }`;
}

function createProjectStatusFieldMutation(): string {
  return `mutation($projectId:ID!, $options:[ProjectV2SingleSelectFieldOptionInput!]) {
    createProjectV2Field(input:{
      projectId:$projectId,
      dataType:SINGLE_SELECT,
      name:"Status",
      singleSelectOptions:$options
    }) {
      projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } }
    }
  }`;
}

function updateProjectStatusFieldMutation(): string {
  return `mutation($fieldId:ID!, $options:[ProjectV2SingleSelectFieldOptionInput!]) {
    updateProjectV2Field(input:{
      fieldId:$fieldId,
      name:"Status",
      singleSelectOptions:$options
    }) {
      projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } }
    }
  }`;
}

function statusOptionFieldArgs(): string[] {
  const args: string[] = [];
  for (const option of TWINDEM_PROJECT_STATUS_OPTIONS) {
    args.push("-F", `options[][name]=${option.name}`);
    args.push("-F", `options[][color]=${option.color}`);
    args.push("-F", `options[][description]=${option.description}`);
  }
  return args;
}

function updateSingleSelectMutation(): string {
  return `mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
    updateProjectV2ItemFieldValue(input:{
      projectId:$projectId,
      itemId:$itemId,
      fieldId:$fieldId,
      value:{singleSelectOptionId:$optionId}
    }) {
      projectV2Item { id }
    }
  }`;
}

function deleteProjectItemMutation(): string {
  return `mutation($projectId:ID!, $itemId:ID!) {
    deleteProjectV2Item(input:{projectId:$projectId, itemId:$itemId}) {
      deletedItemId
    }
  }`;
}

function projectFromGraphql(response: Record<string, unknown>): Record<string, unknown> | null {
  const data = record(response.data);
  const organizationProject = record(record(data.organization).projectV2);
  if (organizationProject.id) return organizationProject;
  const userProject = record(record(data.user).projectV2);
  if (userProject.id) return userProject;
  return null;
}

function singleSelectFieldsFromGraphql(project: Record<string, unknown>): ProjectFieldValueSnapshot["singleSelectFields"] {
  return graphqlNodes(project.fields)
    .filter((field) => Array.isArray(field.options))
    .map((field) => ({
      id: String(field.id),
      name: String(field.name),
      options: graphqlNodes({ nodes: field.options }).map((option) => ({
        id: String(option.id),
        name: String(option.name)
      }))
    }));
}

function fieldValuesFromGraphql(item: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const node of graphqlNodes(item.fieldValues)) {
    const fieldName = record(node.field).name;
    if (typeof fieldName !== "string") continue;
    const rawValue = node.name ?? node.text ?? node.number ?? node.date ?? node.title;
    if (rawValue === undefined || rawValue === null) continue;
    values[fieldName] = String(rawValue);
  }
  return values;
}

function graphqlNodes(connection: unknown): Array<Record<string, unknown>> {
  const nodes = record(connection).nodes;
  return Array.isArray(nodes) ? nodes.map(record).filter(Boolean) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function projectItemRepo(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const urlMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)(?:\/.*)?$/);
  if (urlMatch) return urlMatch[1];
  const repoMatch = trimmed.match(/^[^/\s]+\/[^/\s]+$/);
  return repoMatch ? trimmed : null;
}

function parseGithubRepo(remoteUrl: string): Omit<GitHubRepoOption, "path"> | null {
  const normalized = remoteUrl.trim().replace(/\.git$/, "");
  const match =
    normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/) ??
    normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/) ??
    normalized.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const [, owner, name] = match;
  return {
    owner,
    name,
    fullName: `${owner}/${name}`
  };
}
