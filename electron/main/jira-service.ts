import type { BoardArtifactOption, JiraProjectOption, JiraProjectStatuses } from "../../shared/domain.js";

export type JiraCredentials = {
  siteUrl: string;
  email: string;
  apiToken: string;
};

export type JiraIssueInput = {
  projectKey: string;
  issueType: string;
  title: string;
  body?: string;
  labels?: string[];
};

export type JiraProjectInput = {
  key: string;
  name: string;
};

// Company-managed software project with a simple Kanban board. Team-managed (next-gen) projects use a
// different creation API and are out of scope for v1.
const DEFAULT_PROJECT_TEMPLATE_KEY = "com.pyxis.greenhopper.jira:gh-simplified-kanban-classic";
const JIRA_PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

type JiraProjectSearchResponse = {
  values?: Array<{ id: string; key: string; name?: string }>;
  startAt?: number;
  maxResults?: number;
  isLast?: boolean;
  total?: number;
};

type JiraSearchResponse = {
  issues?: Array<{
    id: string;
    key: string;
    self?: string;
    fields?: {
      summary?: string;
      description?: unknown;
      status?: { name?: string };
      issuetype?: { name?: string };
      labels?: string[];
    };
  }>;
};

type JiraCreateResponse = {
  id: string;
  key: string;
  self?: string;
};

type JiraTransitionsResponse = {
  transitions?: Array<{ id: string; name: string; to?: { name?: string } }>;
};

type JiraIssueStatusResponse = {
  fields?: {
    status?: { name?: string };
  };
};

type JiraIssueEditResponse = {
  id?: string;
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    labels?: string[];
  };
};

// GET /rest/api/3/project/{key}/statuses returns statuses grouped per issue type.
type JiraProjectStatusesResponse = Array<{
  id?: string;
  name?: string;
  statuses?: Array<{ id?: string; name?: string }>;
}>;

export class JiraService {
  constructor(private readonly credentials: JiraCredentials) {}

  async authStatus(): Promise<{ ok: boolean; message: string }> {
    const data = await this.request<{ accountId?: string; displayName?: string }>("/rest/api/3/myself");
    return {
      ok: Boolean(data.accountId),
      message: data.displayName ? `Jira authenticated as ${data.displayName}.` : "Jira authentication succeeded."
    };
  }

  async listIssues(projectKey: string, maxResults = 100): Promise<BoardArtifactOption[]> {
    const jql = `project = ${projectKey} ORDER BY updated DESC`;
    const data = await this.request<JiraSearchResponse>(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,description,status,issuetype,labels`
    );
    return (data.issues ?? []).map((issue) => ({
      id: issue.id,
      provider: "jira",
      kind: "jira_issue",
      type: "Issue",
      key: issue.key,
      title: issue.fields?.summary ?? issue.key,
      body: jiraDocumentText(issue.fields?.description),
      url: `${this.baseUrl()}/browse/${issue.key}`,
      status: issue.fields?.status?.name,
      labels: Array.from(new Set([...(issue.fields?.labels ?? []), ...(issue.fields?.issuetype?.name ? [issue.fields.issuetype.name] : [])]))
    }));
  }

  async getAccountId(): Promise<string> {
    const data = await this.request<{ accountId?: string }>("/rest/api/3/myself");
    if (!data.accountId) throw new Error("Could not read your Jira account id (needed to set the project lead).");
    return data.accountId;
  }

  // Paginated: /rest/api/3/project/search returns a PageBeanProject, not a bare array. Walk every page.
  async listProjects(): Promise<JiraProjectOption[]> {
    const projects: JiraProjectOption[] = [];
    const maxResults = 50;
    let startAt = 0;
    // Hard cap on pages as a runaway guard (50 * 40 = 2000 projects).
    for (let page = 0; page < 40; page += 1) {
      const data = await this.request<JiraProjectSearchResponse>(
        `/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}&orderBy=name`
      );
      for (const project of data.values ?? []) {
        projects.push({ id: project.id, key: project.key, name: project.name ?? project.key });
      }
      const pageSize = data.maxResults ?? maxResults;
      if (data.isLast || !data.values || data.values.length === 0 || data.values.length < pageSize) break;
      startAt += pageSize;
    }
    return projects;
  }

  async createProject(input: JiraProjectInput): Promise<JiraProjectOption> {
    const key = input.key.trim().toUpperCase();
    const name = input.name.trim();
    if (!JIRA_PROJECT_KEY_PATTERN.test(key)) {
      throw new Error("Invalid project key. Use 2–10 characters: an uppercase letter followed by letters/digits (e.g. POS).");
    }
    if (!name) throw new Error("Project name is required.");
    const leadAccountId = await this.getAccountId();
    try {
      const data = await this.request<JiraCreateResponse>("/rest/api/3/project", {
        method: "POST",
        body: JSON.stringify({
          key,
          name,
          projectTypeKey: "software",
          projectTemplateKey: DEFAULT_PROJECT_TEMPLATE_KEY,
          leadAccountId
        })
      });
      // Jira can answer 2xx without actually creating a project — most often when the key or name
      // collides with a recently DELETED project still sitting in the trash (the key stays reserved
      // for ~60 days). Without this guard the UI would silently report "success" and create nothing.
      if (!data?.id || !data?.key) {
        throw new Error(
          `Jira didn't create project "${key}". The key or name may already be in use — including a recently deleted project still in the trash (its key stays reserved). Pick a different key/name, or permanently delete / restore the old project in Jira first.`
        );
      }
      return { id: data.id, key: data.key, name };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\b403\b/.test(message) || /permission|not authori[sz]ed|admin/i.test(message)) {
        throw new Error("Creating Jira projects requires Jira admin rights — pick an existing project instead.", { cause: error });
      }
      if (/in the trash|didn't create project/i.test(message)) {
        throw error instanceof Error ? error : new Error(message);
      }
      if (/already exists|duplicate|in use|reserved|\bname\b|\bkey\b/i.test(message)) {
        throw new Error(`That project key "${key}" or name "${name}" already exists, is reserved (deleted project in trash), or is invalid — pick another.`, { cause: error });
      }
      if (/template/i.test(message)) {
        throw new Error("Couldn't create the project with the default template — pick an existing project instead.", { cause: error });
      }
      throw new Error(`Jira project creation failed: ${message}`, { cause: error });
    }
  }

  async createIssue(input: JiraIssueInput): Promise<{ id: string; key: string; url: string }> {
    const body = {
      fields: {
        project: { key: input.projectKey },
        issuetype: { name: input.issueType || "Task" },
        summary: input.title,
        description: input.body ? jiraDocument(input.body) : undefined,
        labels: input.labels ?? []
      }
    };
    const data = await this.request<JiraCreateResponse>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify(body)
    });
    return { id: data.id, key: data.key, url: `${this.baseUrl()}/browse/${data.key}` };
  }

  async getIssue(issueKey: string): Promise<BoardArtifactOption> {
    const issue = await this.request<{
      id: string;
      key: string;
      fields?: { summary?: string; description?: unknown; status?: { name?: string }; issuetype?: { name?: string }; labels?: string[] };
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,issuetype,labels`);
    return {
      id: issue.id,
      provider: "jira",
      kind: "jira_issue",
      type: "Issue",
      key: issue.key,
      title: issue.fields?.summary ?? issue.key,
      body: jiraDocumentText(issue.fields?.description),
      url: `${this.baseUrl()}/browse/${issue.key}`,
      status: issue.fields?.status?.name,
      labels: Array.from(new Set([...(issue.fields?.labels ?? []), ...(issue.fields?.issuetype?.name ? [issue.fields.issuetype.name] : [])]))
    };
  }

  async updateIssue(
    issueKey: string,
    input: { title?: string; body?: string; labels?: string[] }
  ): Promise<BoardArtifactOption> {
    const fields: Record<string, unknown> = {};
    if (input.title !== undefined) fields.summary = input.title;
    if (input.body !== undefined) fields.description = jiraDocument(input.body);
    if (input.labels !== undefined) fields.labels = input.labels;
    await this.request<JiraIssueEditResponse>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: "PUT",
      body: JSON.stringify({ fields })
    });
    return this.getIssue(issueKey);
  }

  async transitionIssue(issueKey: string, statusName: string): Promise<boolean> {
    const wanted = normalizeJiraName(statusName);
    const current = await this.request<JiraIssueStatusResponse>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`
    );
    if (normalizeJiraName(current.fields?.status?.name) === wanted) return true;
    const transitions = await this.request<JiraTransitionsResponse>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
    const transition = (transitions.transitions ?? []).find(
      (candidate) => normalizeJiraName(candidate.name) === wanted || normalizeJiraName(candidate.to?.name) === wanted
    );
    if (!transition) return false;
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } })
    });
    return true;
  }

  // The status names an issue can currently move to (transition target names) + its current status.
  // Used to build a helpful error when none of Twindem's slot candidates match the project's workflow.
  async availableStatuses(issueKey: string): Promise<string[]> {
    const names = new Set<string>();
    try {
      const current = await this.request<JiraIssueStatusResponse>(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`
      );
      if (current.fields?.status?.name) names.add(current.fields.status.name);
      const transitions = await this.request<JiraTransitionsResponse>(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`
      );
      for (const t of transitions.transitions ?? []) {
        if (t.to?.name) names.add(t.to.name);
        else if (t.name) names.add(t.name);
      }
    } catch {
      /* best-effort — return whatever we gathered */
    }
    return Array.from(names);
  }

  // Lists the real status names configured for a project, scoped to one issue type when given.
  // Onboarding-friendly: needs no existing issue (unlike availableStatuses). If the issue type isn't
  // found, falls back to the union of all issue types and flags `unioned` so the UI can warn.
  async listProjectStatuses(projectKeyOrId: string, issueTypeName?: string): Promise<JiraProjectStatuses> {
    const data = await this.request<JiraProjectStatusesResponse>(
      `/rest/api/3/project/${encodeURIComponent(projectKeyOrId)}/statuses`
    );
    const groups = Array.isArray(data) ? data : [];
    const wantedType = normalizeJiraName(issueTypeName);
    const collect = (filterByType: boolean): string[] => {
      const names = new Set<string>();
      for (const group of groups) {
        if (filterByType && normalizeJiraName(group.name) !== wantedType) continue;
        for (const status of group.statuses ?? []) {
          if (status?.name) names.add(status.name);
        }
      }
      return Array.from(names);
    };
    if (wantedType) {
      const matched = groups.some((group) => normalizeJiraName(group.name) === wantedType);
      if (matched) return { statuses: collect(true), unioned: false };
    }
    return { statuses: collect(false), unioned: Boolean(wantedType) };
  }

  async addComment(issueKeyOrId: string, body: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKeyOrId)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: jiraDocument(body) })
    });
  }

  // Replace the issue description with Agent 1's latest plan (so the reviewer reads the current plan,
  // not the original one-line theme). Mirrors createIssue's description encoding.
  async updateDescription(issueKeyOrId: string, body: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKeyOrId)}`, {
      method: "PUT",
      body: JSON.stringify({ fields: { description: jiraDocument(body) } })
    });
  }

  async deleteIssue(issueKeyOrId: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKeyOrId)}`, {
      method: "DELETE"
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.credentials.email}:${this.credentials.apiToken}`).toString("base64")}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text().catch(() => "");
      // A non-JSON error body (an HTML 404/login page) almost always means the site URL is wrong —
      // e.g. https://www.atlassian.com instead of https://your-domain.atlassian.net. Don't dump the
      // whole HTML page; give an actionable hint.
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new Error(
          `Jira didn't respond as an API at ${this.baseUrl()} (HTTP ${response.status}). Check the site URL — it must be your Jira Cloud base URL, e.g. https://your-domain.atlassian.net, not atlassian.com or a board link.`
        );
      }
      const message = apiErrorText(text);
      throw new Error(`Jira request failed (${response.status}): ${message || response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (!contentType.toLowerCase().includes("application/json")) {
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 140);
      throw new Error(
        `Jira returned ${contentType || "non-JSON"} instead of JSON. Use the Jira site base URL, e.g. https://your-domain.atlassian.net, not the full board URL.${preview ? ` Response starts with: ${preview}` : ""}`
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`Jira returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private baseUrl(): string {
    const raw = this.credentials.siteUrl.trim();
    try {
      const url = new URL(raw);
      return url.origin;
    } catch {
      return raw.replace(/\/+$/, "");
    }
  }
}

function normalizeJiraName(value?: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Pull a human message out of a Jira JSON error body ({errorMessages:[...], errors:{...}}).
function apiErrorText(body: string): string {
  if (!body.trim()) return "";
  try {
    const parsed = JSON.parse(body) as { errorMessages?: string[]; errors?: Record<string, string> };
    const messages = [...(parsed.errorMessages ?? []), ...Object.values(parsed.errors ?? {})].filter(Boolean);
    if (messages.length > 0) return messages.join("; ");
  } catch {
    /* fall through */
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

function jiraDocumentText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(jiraDocumentText).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  const node = value as { text?: unknown; content?: unknown; attrs?: { text?: unknown } };
  const text = typeof node.text === "string" ? node.text : typeof node.attrs?.text === "string" ? node.attrs.text : "";
  const children = jiraDocumentText(node.content);
  return [text, children].filter(Boolean).join(text && children ? " " : "");
}

function jiraDocument(markdown: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: markdown.split(/\n{2,}/).map((paragraph) => ({
      type: "paragraph",
      content: [{ type: "text", text: paragraph.trim() || " " }]
    }))
  };
}
