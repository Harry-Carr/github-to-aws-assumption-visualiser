import {
  buildSankey,
  detailForSelection,
  resolveMid,
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
const filters: FilterState = {
  org: "",
  role: "",
  minCount: 1,
  hideUnknownWorkflow: false,
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

console.log("aggregate resolveMid + selection tests ok");
