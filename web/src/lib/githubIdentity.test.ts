import {
  isGitHubOidcEvent,
  parseAssumeEvent,
  parseBranchFromSub,
  parseEnvironmentFromSub,
  parseRepoFromSub,
  workflowFromEvent,
} from "./githubIdentity";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(parseRepoFromSub("repo:acme/widgets:ref:refs/heads/main")?.[0] === "acme", "org");
assert(parseRepoFromSub("repo:acme/widgets:ref:refs/heads/main")?.[1] === "widgets", "repo");
assert(
  parseBranchFromSub("repo:acme/widgets:ref:refs/heads/main") === "main",
  "branch",
);
assert(
  parseBranchFromSub("repo:acme/widgets:ref:refs/tags/v1") === "tag:v1",
  "tag",
);
assert(
  parseEnvironmentFromSub("repo:acme/widgets:environment:prod") === "prod",
  "env",
);
assert(
  parseEnvironmentFromSub(
    "repo:SynkySoftware@289148737/synky-demo-02@1300903602:environment:dev",
  ) === "dev",
  "env synky-style sub",
);
assert(parseEnvironmentFromSub("repo:acme/widgets:ref:refs/heads/main") === "unknown", "no env");
assert(parseBranchFromSub("repo:acme/widgets:environment:dev") === "unknown", "env-only no branch");

const event = {
  eventTime: "2026-01-15T12:00:00Z",
  userIdentity: {
    type: "WebIdentityUser",
    identityProvider: "token.actions.githubusercontent.com",
    userName: "repo:acme/widgets:ref:refs/heads/main",
  },
  requestParameters: {
    roleArn: "arn:aws:iam::123456789012:role/gha-deploy",
    roleSessionName: "repo:acme/widgets:ref:refs/heads/main",
  },
  additionalEventData: {
    job_workflow_ref: "acme/widgets/.github/workflows/deploy.yml@refs/heads/main",
  },
};

assert(isGitHubOidcEvent(event), "is github");
assert(workflowFromEvent(event) === "deploy.yml", "workflow");

const parsed = parseAssumeEvent(event);
assert(parsed?.roleName === "gha-deploy", "role");
assert(parsed?.repoFull === "acme/widgets", "repoFull");
assert(parsed?.branch === "main", "parsed branch");
assert(parsed?.environment === "unknown", "parsed env");
assert(parsed?.workflow === "deploy.yml", "parsed workflow");

const nonGh = {
  userIdentity: { identityProvider: "accounts.google.com" },
  requestParameters: { roleArn: "arn:aws:iam::1:role/x" },
};
assert(parseAssumeEvent(nonGh) === null, "reject non-github");

console.log("githubIdentity tests ok");
