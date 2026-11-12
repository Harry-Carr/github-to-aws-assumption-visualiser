/** Parse GitHub Actions identity fields from CloudTrail AssumeRoleWithWebIdentity events. */

export const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";

const REPO_SUB_RE = /^repo:([^/]+)\/([^:]+)/;
const REPO_ANY_RE = /repo:([^/]+)\/([^:\s]+)/;
const WORKFLOW_PATH_RE =
  /(?:^|[/])\.github\/workflows\/([A-Za-z0-9_.-]+\.ya?ml)(?:@|$)/i;
const JOB_WORKFLOW_REF_RE =
  /(?:job_workflow_ref[=:\s"]+|\/)([^/\s"']+\/[^/\s"']+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)(?:@[^\s"']*)?/i;

export type ParsedAssume = {
  roleArn: string;
  roleName: string;
  org: string;
  repo: string;
  repoFull: string;
  branch: string;
  environment: string;
  workflow: string;
  subject: string | null;
  eventTime: string | null;
};

export function parseRepoFromSub(sub: string): [string, string] | null {
  const match = REPO_SUB_RE.exec(sub);
  if (!match) return null;
  return [match[1], match[2]];
}

export function parseBranchFromSub(sub: string | null | undefined): string {
  if (!sub) return "unknown";
  // Standard GitHub Actions OIDC sub ref claims
  for (const marker of [
    ":ref:refs/heads/",
    ":ref:refs/tags/",
    "ref:refs/heads/",
    "ref:refs/tags/",
  ]) {
    const idx = sub.toLowerCase().indexOf(marker.toLowerCase());
    if (idx >= 0) {
      const rest = sub.slice(idx + marker.length);
      const end = rest.search(/[:\s]/);
      const name = (end >= 0 ? rest.slice(0, end) : rest).trim();
      if (name) {
        return marker.toLowerCase().includes("tags") ? `tag:${name}` : name;
      }
    }
  }
  if (/:pull_request\b/i.test(sub) || /:pull_request_target\b/i.test(sub)) {
    return "pull_request";
  }
  return "unknown";
}

export function parseEnvironmentFromSub(
  sub: string | null | undefined,
): string {
  if (!sub) return "unknown";
  // e.g. repo:org/repo:environment:dev
  const match = /(?::|^)environment:([^\s:]+)/i.exec(sub);
  if (!match) return "unknown";
  return match[1].trim() || "unknown";
}

export function isGitHubOidcEvent(event: Record<string, unknown>): boolean {
  const user = (event.userIdentity as Record<string, unknown> | undefined) || {};
  const provider = String(user.identityProvider || "").toLowerCase();
  if (provider.includes(GITHUB_OIDC_HOST)) return true;

  for (const value of [user.userName, user.principalId]) {
    if (typeof value === "string" && value.includes("repo:")) return true;
  }
  return false;
}

export function subFromCloudTrailEvent(
  event: Record<string, unknown>,
): string | null {
  const user = (event.userIdentity as Record<string, unknown> | undefined) || {};
  for (const value of [user.userName, user.principalId]) {
    if (typeof value !== "string") continue;
    if (value.startsWith("repo:")) return value;
    const match = /(repo:[^:\s]+(?::[^:\s]+)*)/.exec(value);
    if (match) return match[1];
  }
  return null;
}

export function repoFromCloudTrailEvent(
  event: Record<string, unknown>,
): string | null {
  const user = (event.userIdentity as Record<string, unknown> | undefined) || {};
  const request =
    (event.requestParameters as Record<string, unknown> | undefined) || {};
  const candidates = [
    user.userName,
    user.principalId,
    request.roleSessionName,
  ];
  for (const value of candidates) {
    if (!value || typeof value !== "string") continue;
    const parsed = parseRepoFromSub(value);
    if (parsed) return `${parsed[0]}/${parsed[1]}`;
    const match = REPO_ANY_RE.exec(value);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 200) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out, depth + 1);
    }
  }
}

export function workflowFromEvent(event: Record<string, unknown>): string {
  const strings: string[] = [];
  collectStrings(event, strings);
  for (const s of strings) {
    const jobRef = JOB_WORKFLOW_REF_RE.exec(s);
    if (jobRef) {
      const pathMatch = WORKFLOW_PATH_RE.exec(jobRef[1]);
      if (pathMatch) return pathMatch[1];
      return jobRef[1];
    }
    const pathMatch = WORKFLOW_PATH_RE.exec(s);
    if (pathMatch) return pathMatch[1];
  }
  return "unknown";
}

export function roleFromEvent(event: Record<string, unknown>): {
  roleArn: string;
  roleName: string;
} | null {
  const request =
    (event.requestParameters as Record<string, unknown> | undefined) || {};
  const roleArn = String(request.roleArn || "");
  if (!roleArn) return null;
  const roleName = roleArn.includes("/")
    ? roleArn.slice(roleArn.lastIndexOf("/") + 1)
    : roleArn;
  return { roleArn, roleName };
}

export function parseAssumeEvent(
  event: Record<string, unknown>,
): ParsedAssume | null {
  if (!isGitHubOidcEvent(event)) return null;
  const role = roleFromEvent(event);
  if (!role) return null;
  const repoFull = repoFromCloudTrailEvent(event);
  if (!repoFull || !repoFull.includes("/")) return null;
  const [org, repo] = repoFull.split("/", 2);
  const subject = subFromCloudTrailEvent(event);
  const eventTime =
    typeof event.eventTime === "string"
      ? event.eventTime
      : event.eventTime != null
        ? String(event.eventTime)
        : null;

  return {
    roleArn: role.roleArn,
    roleName: role.roleName,
    org,
    repo,
    repoFull,
    branch: parseBranchFromSub(subject),
    environment: parseEnvironmentFromSub(subject),
    workflow: workflowFromEvent(event),
    subject,
    eventTime,
  };
}
