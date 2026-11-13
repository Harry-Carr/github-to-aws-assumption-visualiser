import {
  buildSankey,
  detailForSelection,
  matchingPaths,
  matchWildcard,
  resolveMid,
  tableRowsFromPaths,
  type FilterState,
} from "./aggregate";
import type { ParsedAssume } from "./githubIdentity";

function row(partial: Partial<ParsedAssume>): ParsedAssume {
  return {
    roleArn: "arn:aws:iam::1:role/r",
    roleName: "r",
    org: "o",
    repo: "repo",
    repoFull: "o/repo",
    branch: "unknown",
    environment: "unknown",
    workflow: "w.yml",
    subject: null,
    eventTime: null,
    ...partial,
  };
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const envOnly = row({
  environment: "dev",
  subject: "repo:o/repo:environment:dev",
});
assert(resolveMid(envOnly, "branch").label === "dev", "branch mode falls back to env");
assert(
  resolveMid(envOnly, "branch").kind === "environment",
  "kind becomes environment",
);
assert(resolveMid(envOnly, "environment").label === "dev", "env mode uses env");

const branchOnly = row({ branch: "main" });
assert(
  resolveMid(branchOnly, "environment").label === "main",
  "env mode falls back to branch",
);
assert(resolveMid(branchOnly, "environment").kind === "branch", "kind becomes branch");

const both = row({ branch: "main", environment: "prod" });
assert(resolveMid(both, "branch").label === "main", "prefer branch when selected");
assert(resolveMid(both, "environment").label === "prod", "prefer env when selected");

// Aggregation: org→repo link sums all leaf paths (12+1=13)
assert(matchWildcard("", "x"), "empty pattern matches");
assert(matchWildcard("savings*", "savings-prod"), "prefix *");
assert(matchWildcard("*savings", "my-savings"), "suffix *");
assert(matchWildcard("*save*", "my-save-now"), "contains *");
assert(!matchWildcard("savings*", "prod-savings"), "prefix reject");
assert(matchWildcard("Acme", "acme"), "exact case-insensitive");
assert(!matchWildcard("Acme", "AcmeCorp"), "exact no partial without *");

const filters: FilterState = {
  org: "",
  repo: "",
  role: "",
  minCount: 1,
  hideUnknownMid: false,
  midStage: "environment",
};
const rows: ParsedAssume[] = [
  ...Array.from({ length: 12 }, () =>
    row({
      org: "SynkySoftware",
      repo: "demo",
      repoFull: "SynkySoftware/demo",
      environment: "dev",
      roleName: "role-a",
      roleArn: "arn:aws:iam::1:role/role-a",
    }),
  ),
  row({
    org: "SynkySoftware",
    repo: "demo",
    repoFull: "SynkySoftware/demo",
    environment: "dev",
    roleName: "role-b",
    roleArn: "arn:aws:iam::1:role/role-b",
  }),
];
const model = buildSankey(rows, filters);
const orgRepo = detailForSelection(
  model,
  "link",
  "org:SynkySoftware",
  "repo:SynkySoftware/demo",
);
assert(orgRepo?.count === 13, `org→repo should be 13, got ${orgRepo?.count}`);
assert(orgRepo?.pathCount === 2, "two leaf paths under org→repo");

const leaf = detailForSelection(
  model,
  "link",
  "environment:SynkySoftware/demo:dev",
  "role:role-a",
);
assert(leaf?.count === 12, `leaf link should be 12, got ${leaf?.count}`);

const rolePaths = matchingPaths(model, "node", "role:role-a");
assert(rolePaths.length >= 1, "matchingPaths returns role paths");
assert(
  rolePaths.every((p) => p.roleName === "role-a"),
  "matchingPaths scoped to role",
);
const roleRows = tableRowsFromPaths(rolePaths);
assert(roleRows[0]?.roleName === "role-a", "tableRowsFromPaths keeps role");

// High-cardinality mid collapse: keep top mids, roll rest into other
const busyFilters: FilterState = { ...filters, midStage: "branch", minCount: 1 };
const busyRows: ParsedAssume[] = [];
for (let i = 0; i < 20; i++) {
  busyRows.push(
    ...Array.from({ length: 20 - i }, () =>
      row({
        org: "o",
        repo: "demo",
        repoFull: "o/demo",
        branch: `tag:v${i}`,
        roleName: "deploy",
        roleArn: "arn:aws:iam::1:role/deploy",
      }),
    ),
  );
}
const busy = buildSankey(busyRows, busyFilters);
assert(busy.truncation?.midsCollapsed, "should collapse excess mids");
const midNodes = busy.nodes.filter((n) => n.depth === 2);
assert(
  midNodes.length <= 13,
  `mid column capped, got ${midNodes.length}`,
);
assert(
  midNodes.some((n) => n.name.startsWith("other")),
  "other mid bucket present",
);

const wildcardRows: ParsedAssume[] = [
  row({ org: "savings-prod", repo: "ledger", repoFull: "savings-prod/ledger" }),
  row({ org: "payments", repo: "savings-api", repoFull: "payments/savings-api" }),
  row({ org: "other", repo: "misc", repoFull: "other/misc" }),
];
const byOrg = buildSankey(wildcardRows, { ...filters, org: "savings*" });
assert(
  byOrg.nodes.some((n) => n.id === "org:savings-prod"),
  "org savings* keeps savings-prod",
);
assert(
  !byOrg.nodes.some((n) => n.id === "org:payments"),
  "org savings* drops payments",
);
const byRepo = buildSankey(wildcardRows, { ...filters, repo: "*savings*" });
assert(
  byRepo.nodes.some((n) => n.id === "repo:payments/savings-api"),
  "repo *savings* keeps savings-api",
);
assert(
  !byRepo.nodes.some((n) => n.id === "repo:other/misc"),
  "repo *savings* drops misc",
);

console.log("aggregate resolveMid + selection tests ok");
