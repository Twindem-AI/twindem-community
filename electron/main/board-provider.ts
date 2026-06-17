import type {
  BoardArtifactOption,
  GitHubAuthStatus,
  GitHubIssueContext,
  GitHubProjectOption,
  GitHubProjectOwnerOption,
  GitHubRepoOption,
  TaskReviewVerdict
} from "../../shared/domain.js";
import { GitHubService } from "./github-service.js";

export type TaskReviewLabels = {
  requested: string;
  ok: string;
  changes: string;
};

export interface BoardProvider {
  readonly key: "github";
  authStatus(): Promise<GitHubAuthStatus>;
  connect(): Promise<GitHubAuthStatus>;
  listProjects(): Promise<GitHubProjectOption[]>;
  listProjectOwners(): Promise<GitHubProjectOwnerOption[]>;
  createProject(owner: string, title: string): Promise<GitHubProjectOption>;
  listWorkspaceRepos(workspaceRoot: string): Promise<GitHubRepoOption[]>;
  listArtifacts(owner: string, projectNumber: number): Promise<BoardArtifactOption[]>;
  createDraftArtifact(owner: string, projectNumber: number, title: string, body: string): Promise<{ id: string; title: string; body: string; url?: string; fetchedAt: string }>;
  getArtifact(repo: string, issueNumber: number, projectOwner?: string, projectNumber?: number): Promise<GitHubIssueContext>;
  createArtifact(repo: string, title: string, body: string, labels?: string[]): Promise<GitHubIssueContext>;
  updateArtifact(repo: string, issueNumber: number, input: { title?: string; body?: string; addLabels?: string[]; removeLabels?: string[] }): Promise<GitHubIssueContext>;
  updateArtifactBody(repo: string, issueNumber: number, body: string): Promise<void>;
  commentArtifact(repo: string, issueNumber: number, body: string): Promise<void>;
  closeArtifact(repo: string, issueNumber: number, commentBody?: string): Promise<void>;
  addArtifactToProject(owner: string, projectNumber: number, url: string): Promise<boolean>;
  removeArtifactFromProject(owner: string, projectNumber: number, repo: string, issueNumber: number): Promise<boolean>;
  removeProjectItem(owner: string, projectNumber: number, itemId: string): Promise<boolean>;
  updateStatus(owner: string, projectNumber: number, repo: string, issueNumber: number, status: string | string[]): Promise<boolean>;
  updateProjectItemStatus(owner: string, projectNumber: number, itemId: string, status: string | string[]): Promise<boolean>;
  requestTaskReview(repo: string, issueNumber: number, requestedLabel: string, commentBody?: string): Promise<void>;
  applyTaskReviewVerdict(
    repo: string,
    issueNumber: number,
    verdict: Exclude<TaskReviewVerdict, "requested">,
    labels: TaskReviewLabels,
    commentBody?: string
  ): Promise<void>;
}

export class GitHubBoardProvider implements BoardProvider {
  readonly key = "github" as const;

  constructor(private readonly github: GitHubService) {}

  authStatus(): Promise<GitHubAuthStatus> {
    return this.github.authStatus();
  }

  connect(): Promise<GitHubAuthStatus> {
    return this.github.login();
  }

  listProjects(): Promise<GitHubProjectOption[]> {
    return this.github.listProjects();
  }

  listProjectOwners(): Promise<GitHubProjectOwnerOption[]> {
    return this.github.listProjectOwners();
  }

  createProject(owner: string, title: string): Promise<GitHubProjectOption> {
    return this.github.createProject(owner, title);
  }

  listWorkspaceRepos(workspaceRoot: string): Promise<GitHubRepoOption[]> {
    return this.github.listWorkspaceRepos(workspaceRoot);
  }

  listArtifacts(owner: string, projectNumber: number): Promise<BoardArtifactOption[]> {
    return this.github.listProjectIssues(owner, projectNumber);
  }

  createDraftArtifact(owner: string, projectNumber: number, title: string, body: string) {
    return this.github.createDraftIssue(owner, projectNumber, title, body);
  }

  async getArtifact(
    repo: string,
    issueNumber: number,
    projectOwner?: string,
    projectNumber?: number
  ): Promise<GitHubIssueContext> {
    const issue = await this.github.viewIssue(repo, issueNumber);
    if (!projectOwner || !projectNumber) return issue;
    const snapshot = await this.github.projectFieldSnapshot(projectOwner, projectNumber, repo, issueNumber);
    if (!snapshot) return issue;
    return {
      ...issue,
      projectStatus: snapshot.fields.Status ?? issue.projectStatus,
      projectFields: {
        ...issue.projectFields,
        ...snapshot.fields
      }
    };
  }

  createArtifact(repo: string, title: string, body: string, labels?: string[]): Promise<GitHubIssueContext> {
    return this.github.createIssue(repo, title, body, labels);
  }

  updateArtifact(
    repo: string,
    issueNumber: number,
    input: { title?: string; body?: string; addLabels?: string[]; removeLabels?: string[] }
  ): Promise<GitHubIssueContext> {
    return this.github.updateIssue(repo, issueNumber, input);
  }

  updateArtifactBody(repo: string, issueNumber: number, body: string): Promise<void> {
    return this.github.updateIssueBody(repo, issueNumber, body);
  }

  commentArtifact(repo: string, issueNumber: number, body: string): Promise<void> {
    return this.github.commentIssue(repo, issueNumber, body);
  }

  closeArtifact(repo: string, issueNumber: number, commentBody?: string): Promise<void> {
    return this.github.closeIssue(repo, issueNumber, commentBody);
  }

  addArtifactToProject(owner: string, projectNumber: number, url: string): Promise<boolean> {
    return this.github.addIssueToProject(owner, projectNumber, url);
  }

  removeArtifactFromProject(owner: string, projectNumber: number, repo: string, issueNumber: number): Promise<boolean> {
    return this.github.removeIssueFromProject(owner, projectNumber, repo, issueNumber);
  }

  removeProjectItem(owner: string, projectNumber: number, itemId: string): Promise<boolean> {
    return this.github.removeProjectItem(owner, projectNumber, itemId);
  }

  updateStatus(owner: string, projectNumber: number, repo: string, issueNumber: number, status: string | string[]): Promise<boolean> {
    return this.github.setProjectStatus(owner, projectNumber, repo, issueNumber, status);
  }

  updateProjectItemStatus(owner: string, projectNumber: number, itemId: string, status: string | string[]): Promise<boolean> {
    return this.github.setProjectItemStatus(owner, projectNumber, itemId, status);
  }

  requestTaskReview(repo: string, issueNumber: number, requestedLabel: string, commentBody?: string): Promise<void> {
    return this.github.requestTaskReview(repo, issueNumber, requestedLabel, commentBody);
  }

  applyTaskReviewVerdict(
    repo: string,
    issueNumber: number,
    verdict: Exclude<TaskReviewVerdict, "requested">,
    labels: TaskReviewLabels,
    commentBody?: string
  ): Promise<void> {
    return this.github.applyTaskReviewVerdict(repo, issueNumber, verdict, labels, commentBody);
  }
}
