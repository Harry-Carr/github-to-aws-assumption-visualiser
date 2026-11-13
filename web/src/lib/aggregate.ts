import type { ParsedAssume } from "./githubIdentity";

export type MidStage = "branch" | "environment";

export type FilterState = {
  /** Org name glob (`platform*`, `*corp`). Empty = all. */
  org: string;
  /** Repo short or `org/repo` glob (`*api`, `security*`). Empty = all. */
  repo: string;
  role: string;
  minCount: number;
  hideUnknownMid: boolean;
  midStage: MidStage;
};

/**
 * Glob match with `*` = any run of chars. Case-insensitive.
 * No `*` → exact match. Empty pattern → always true.
 */
export function matchWildcard(pattern: string, value: string): boolean {
  const p = pattern.trim();
  if (!p) return true;
  const escaped = p
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export type SankeyNode = {
  id: string;
  /** Short label for the chart (org | repo | branch/env | role) */
  name: string;
  /** 0 = org, 1 = repo, 2 = branch|env, 3 = IAM role */
  depth: number;
  count: number;
};

/** Repo short name from org/repo. */
export function shortRepoName(repoFull: string): string {
  const i = repoFull.lastIndexOf("/");
  return i >= 0 ? repoFull.slice(i + 1) : repoFull;
}

/** Truncate long IAM role names for the chart axis. */
export function shortRoleName(roleName: string, max = 22): string {
  if (roleName.length <= max) return roleName;
  return `${roleName.slice(0, Math.max(1, max - 1))}…`;
}

export type SankeyLink = {
  source: string;
  target: string;
  value: number;
};

export type PathDetail = {
  org: string;
  repoFull: string;
  midLabel: string;
  midKind: MidStage;
  roleName: string;
  roleArn: string;
  count: number;
  subjects: string[];
  eventTimes: string[];
  /** How many fine-grained paths were rolled into this selection */
  pathCount: number;
  /** Selection scope label, e.g. org→repo link vs single role leaf */
  scope: string;
};

export type SankeyTruncation = {
  /** Mid (branch/env) values rolled into per-repo "other" */
  midsCollapsed: number;
  /** Distinct roles rolled into "other roles" */
  rolesCollapsed: number;
  /** Distinct repos rolled into "other repos" */
  reposCollapsed: number;
};

export type SankeyModel = {
  nodes: SankeyNode[];
  links: SankeyLink[];
  /** Finest grain paths (org/repo/mid/role) for click detail */
  paths: Map<string, PathDetail>;
  maxLinkValue: number;
  /** Present when chart cardinality was capped for layout. */
  truncation?: SankeyTruncation;
};

/** Soft caps so ECharts sankey can layout inside a scrollable canvas. */
export const SANKEY_MAX_MIDS_PER_REPO = 12;
export const SANKEY_MAX_ROLES = 36;
export const SANKEY_MAX_REPOS = 40;

/**
 * Prefer the selected mid stage; if that claim is missing from the OIDC sub,
 * fall back to the other (many jobs only set environment:… or only ref:…).
 */
export function resolveMid(
  row: ParsedAssume,
  midStage: MidStage,
): { label: string; kind: MidStage } {
  const preferred = midStage === "branch" ? row.branch : row.environment;
  const otherKind: MidStage =
    midStage === "branch" ? "environment" : "branch";
  const other = midStage === "branch" ? row.environment : row.branch;
  if (preferred !== "unknown") return { label: preferred, kind: midStage };
  if (other !== "unknown") return { label: other, kind: otherKind };
  return { label: "unknown", kind: midStage };
}

function midId(repoFull: string, mid: string, midKind: MidStage): string {
  return `${midKind}:${repoFull}:${mid}`;
}

function pathKey(
  org: string,
  repoFull: string,
  mid: string,
  roleName: string,
  midStage: MidStage,
): string {
  return `${org}|${repoFull}|${midStage}:${mid}|${roleName}`;
}

function passesFilters(row: ParsedAssume, filters: FilterState): boolean {
  if (filters.org && !matchWildcard(filters.org, row.org)) return false;
  if (filters.repo) {
    const repoOk =
      matchWildcard(filters.repo, row.repo) ||
      matchWildcard(filters.repo, row.repoFull);
    if (!repoOk) return false;
  }
  if (filters.role && row.roleName !== filters.role) return false;
  if (filters.hideUnknownMid) {
    if (resolveMid(row, filters.midStage).label === "unknown") return false;
  }
  return true;
}

export function buildSankey(
  rows: ParsedAssume[],
  filters: FilterState,
): SankeyModel {
  const filtered = rows.filter((r) => passesFilters(r, filters));
  const paths = new Map<string, PathDetail>();

  for (const row of filtered) {
    const resolved = resolveMid(row, filters.midStage);
    const key = pathKey(
      row.org,
      row.repoFull,
      resolved.label,
      row.roleName,
      resolved.kind,
    );
    let path = paths.get(key);
    if (!path) {
      path = {
        org: row.org,
        repoFull: row.repoFull,
        midLabel: resolved.label,
        midKind: resolved.kind,
        roleName: row.roleName,
        roleArn: row.roleArn,
        count: 0,
        subjects: [],
        eventTimes: [],
        pathCount: 1,
        scope: "path",
      };
      paths.set(key, path);
    }
    path.count += 1;
    if (
      row.subject &&
      path.subjects.length < 20 &&
      !path.subjects.includes(row.subject)
    ) {
      path.subjects.push(row.subject);
    }
    if (row.eventTime && path.eventTimes.length < 20) {
      path.eventTimes.push(row.eventTime);
    }
  }

  // Drop thin paths
  for (const [key, path] of [...paths.entries()]) {
    if (path.count < filters.minCount) paths.delete(key);
  }

  const { paths: cappedPaths, truncation } = collapseHighCardinality(paths);

  const linkMap = new Map<string, number>();
  const nodeCount = new Map<string, { name: string; depth: number; count: number }>();

  const bumpNode = (id: string, name: string, depth: number, n: number) => {
    const cur = nodeCount.get(id);
    if (!cur) nodeCount.set(id, { name, depth, count: n });
    else cur.count += n;
  };

  const bumpLink = (source: string, target: string, n: number) => {
    const k = `${source}\0${target}`;
    linkMap.set(k, (linkMap.get(k) || 0) + n);
  };

  for (const path of cappedPaths.values()) {
    // Columns: org → repo → branch|env → role
    const orgId = `org:${path.org}`;
    const repoId = `repo:${path.repoFull}`;
    const mId = midId(path.repoFull, path.midLabel, path.midKind);
    const roleId = `role:${path.roleName}`;

    bumpNode(orgId, path.org, 0, path.count);
    bumpNode(repoId, shortRepoName(path.repoFull), 1, path.count);
    bumpNode(mId, path.midLabel, 2, path.count);
    bumpNode(roleId, shortRoleName(path.roleName), 3, path.count);

    bumpLink(orgId, repoId, path.count);
    bumpLink(repoId, mId, path.count);
    bumpLink(mId, roleId, path.count);
  }

  const nodes: SankeyNode[] = [...nodeCount.entries()]
    .map(([id, meta]) => ({
      id,
      name: meta.name,
      depth: meta.depth,
      count: meta.count,
    }))
    .sort((a, b) => a.depth - b.depth || b.count - a.count);

  let maxLinkValue = 1;
  const links: SankeyLink[] = [];
  for (const [k, value] of linkMap) {
    const [source, target] = k.split("\0");
    links.push({ source, target, value });
    if (value > maxLinkValue) maxLinkValue = value;
  }

  return {
    nodes,
    links,
    paths: cappedPaths,
    maxLinkValue,
    truncation:
      truncation.midsCollapsed ||
      truncation.rolesCollapsed ||
      truncation.reposCollapsed
        ? truncation
        : undefined,
  };
}

/**
 * Cap chart cardinality: rare mids/repos/roles roll into "other" buckets so
 * ECharts sankey can layout. Detail/table still reflect collapsed labels.
 */
export function collapseHighCardinality(
  paths: Map<string, PathDetail>,
  opts?: {
    maxMidsPerRepo?: number;
    maxRoles?: number;
    maxRepos?: number;
  },
): { paths: Map<string, PathDetail>; truncation: SankeyTruncation } {
  const maxMidsPerRepo = opts?.maxMidsPerRepo ?? SANKEY_MAX_MIDS_PER_REPO;
  const maxRoles = opts?.maxRoles ?? SANKEY_MAX_ROLES;
  const maxRepos = opts?.maxRepos ?? SANKEY_MAX_REPOS;

  const truncation: SankeyTruncation = {
    midsCollapsed: 0,
    rolesCollapsed: 0,
    reposCollapsed: 0,
  };

  if (!paths.size) return { paths, truncation };

  // --- Repos: keep top N by total assumes ---
  const repoTotals = new Map<string, number>();
  for (const p of paths.values()) {
    repoTotals.set(p.repoFull, (repoTotals.get(p.repoFull) || 0) + p.count);
  }
  const keepRepos = new Set(
    [...repoTotals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxRepos)
      .map(([repo]) => repo),
  );
  const droppedRepos = [...repoTotals.keys()].filter((r) => !keepRepos.has(r));
  truncation.reposCollapsed = droppedRepos.length;

  // --- Roles: keep top N by total assumes ---
  const roleTotals = new Map<string, number>();
  for (const p of paths.values()) {
    roleTotals.set(p.roleName, (roleTotals.get(p.roleName) || 0) + p.count);
  }
  const keepRoles = new Set(
    [...roleTotals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxRoles)
      .map(([role]) => role),
  );
  const droppedRoles = [...roleTotals.keys()].filter((r) => !keepRoles.has(r));
  truncation.rolesCollapsed = droppedRoles.length;

  // --- Mids: per-repo keep top N ---
  const midTotalsByRepo = new Map<string, Map<string, number>>();
  for (const p of paths.values()) {
    const repoKey = keepRepos.has(p.repoFull) ? p.repoFull : "__other_repos__";
    let mids = midTotalsByRepo.get(repoKey);
    if (!mids) {
      mids = new Map();
      midTotalsByRepo.set(repoKey, mids);
    }
    const midKey = `${p.midKind}:${p.midLabel}`;
    mids.set(midKey, (mids.get(midKey) || 0) + p.count);
  }
  const keepMidsByRepo = new Map<string, Set<string>>();
  for (const [repo, mids] of midTotalsByRepo) {
    const keep = new Set(
      [...mids.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, maxMidsPerRepo)
        .map(([k]) => k),
    );
    keepMidsByRepo.set(repo, keep);
    truncation.midsCollapsed += Math.max(0, mids.size - keep.size);
  }

  const otherOrgLabel = uniqueOrJoin(
    [...paths.values()]
      .filter((x) => !keepRepos.has(x.repoFull))
      .map((x) => x.org),
  );
  const otherRepoFull =
    droppedRepos.length > 0
      ? `__other__/${droppedRepos.length} more repos`
      : "";
  const otherRoleLabel =
    droppedRoles.length > 0 ? `other roles (+${droppedRoles.length})` : "";

  const out = new Map<string, PathDetail>();

  for (const p of paths.values()) {
    let org = p.org;
    let repoFull = p.repoFull;
    let midLabel = p.midLabel;
    const midKind = p.midKind;
    let roleName = p.roleName;
    let roleArn = p.roleArn;

    const repoBucket = keepRepos.has(p.repoFull)
      ? p.repoFull
      : "__other_repos__";

    if (!keepRepos.has(p.repoFull)) {
      org = otherOrgLabel;
      repoFull = otherRepoFull;
    }

    const midKey = `${p.midKind}:${p.midLabel}`;
    const keepMids = keepMidsByRepo.get(repoBucket) ?? new Set<string>();
    if (!keepMids.has(midKey)) {
      const dropped =
        (midTotalsByRepo.get(repoBucket)?.size || 0) - keepMids.size;
      midLabel = `other (+${Math.max(1, dropped)})`;
    }

    if (!keepRoles.has(p.roleName)) {
      roleName = otherRoleLabel;
      roleArn = "—";
    }

    const key = pathKey(org, repoFull, midLabel, roleName, midKind);
    let agg = out.get(key);
    if (!agg) {
      agg = {
        org,
        repoFull,
        midLabel,
        midKind,
        roleName,
        roleArn,
        count: 0,
        subjects: [],
        eventTimes: [],
        pathCount: 0,
        scope: "path",
      };
      out.set(key, agg);
    }
    agg.count += p.count;
    agg.pathCount += p.pathCount;
    for (const s of p.subjects) {
      if (agg.subjects.length < 20 && !agg.subjects.includes(s)) {
        agg.subjects.push(s);
      }
    }
    for (const t of p.eventTimes) {
      if (agg.eventTimes.length < 20) agg.eventTimes.push(t);
    }
  }

  return { paths: out, truncation };
}

export type TableRow = {
  roleName: string;
  roleArn: string;
  repoFull: string;
  org: string;
  mid: string;
  count: number;
};

export function buildTableRows(
  rows: ParsedAssume[],
  filters: FilterState,
): TableRow[] {
  const map = new Map<string, TableRow>();

  for (const row of rows) {
    if (!passesFilters(row, filters)) continue;
    const mid = resolveMid(row, filters.midStage).label;
    const key = `${row.roleName}||${row.repoFull}||${mid}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        roleName: row.roleName,
        roleArn: row.roleArn,
        repoFull: row.repoFull,
        org: row.org,
        mid,
        count: 0,
      };
      map.set(key, entry);
    }
    entry.count += 1;
  }

  const out: TableRow[] = [];
  for (const entry of map.values()) {
    if (entry.count < filters.minCount) continue;
    out.push({ ...entry });
  }

  out.sort((a, b) => b.count - a.count || a.roleName.localeCompare(b.roleName));
  return out;
}

export function toCsv(rows: TableRow[], midStage: MidStage): string {
  const midCol = midStage === "branch" ? "branch" : "environment";
  const header = ["roleName", "roleArn", "org", "repo", midCol, "count"];
  const escape = (v: string | number) => {
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [r.roleName, r.roleArn, r.org, r.repoFull, r.mid, r.count]
        .map(escape)
        .join(","),
    );
  }
  return lines.join("\n");
}

export function uniqueOrgs(rows: ParsedAssume[]): string[] {
  return [...new Set(rows.map((r) => r.org))].sort();
}

export function uniqueRoles(rows: ParsedAssume[]): string[] {
  return [...new Set(rows.map((r) => r.roleName))].sort();
}

function pathMatchesSelection(
  p: PathDetail,
  kind: "node" | "link",
  sourceOrId: string,
  target?: string,
): boolean {
  const orgId = `org:${p.org}`;
  const repoId = `repo:${p.repoFull}`;
  const mId = midId(p.repoFull, p.midLabel, p.midKind);
  const roleId = `role:${p.roleName}`;

  if (kind === "link" && target) {
    const edges: [string, string][] = [
      [orgId, repoId],
      [repoId, mId],
      [mId, roleId],
    ];
    return edges.some(([s, t]) => s === sourceOrId && t === target);
  }

  const id = sourceOrId;
  return (
    id === orgId || id === repoId || id === mId || id === roleId
  );
}

function scopeLabel(
  kind: "node" | "link",
  sourceOrId: string,
  target: string | undefined,
  matched: PathDetail[],
): string {
  if (kind === "link" && target) {
    return `${sourceOrId} → ${target}`;
  }
  if (matched.length === 1) return "single path";
  return `node ${sourceOrId} (${matched.length} paths)`;
}

function uniqueOrJoin(values: string[]): string {
  const u = [...new Set(values.filter(Boolean))];
  if (u.length === 0) return "—";
  if (u.length === 1) return u[0];
  if (u.length <= 3) return u.join(", ");
  return `${u.slice(0, 2).join(", ")} +${u.length - 2} more`;
}

/** Fine-grained paths under a sankey node or link (table + detail). */
export function matchingPaths(
  model: SankeyModel,
  kind: "node" | "link",
  sourceOrId: string,
  target?: string,
): PathDetail[] {
  return [...model.paths.values()]
    .filter((p) => pathMatchesSelection(p, kind, sourceOrId, target))
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.repoFull.localeCompare(b.repoFull) ||
        a.roleName.localeCompare(b.roleName),
    );
}

/** Table rows from already-matched path details (selection-scoped list). */
export function tableRowsFromPaths(paths: PathDetail[]): TableRow[] {
  return paths.map((p) => ({
    roleName: p.roleName,
    roleArn: p.roleArn,
    repoFull: p.repoFull,
    org: p.org,
    mid: p.midLabel,
    count: p.count,
  }));
}

/** Aggregate all fine-grained paths under a sankey node or link (matches tooltip totals). */
export function detailForSelection(
  model: SankeyModel,
  kind: "node" | "link",
  sourceOrId: string,
  target?: string,
): PathDetail | null {
  const matched = matchingPaths(model, kind, sourceOrId, target);
  if (!matched.length) return null;

  const subjects: string[] = [];
  const eventTimes: string[] = [];
  let count = 0;

  for (const p of matched) {
    count += p.count;
    for (const s of p.subjects) {
      if (subjects.length < 20 && !subjects.includes(s)) subjects.push(s);
    }
    for (const t of p.eventTimes) {
      if (eventTimes.length < 20) eventTimes.push(t);
    }
  }

  const orgs = matched.map((p) => p.org);
  const repos = matched.map((p) => p.repoFull);
  const mids = matched.map((p) => p.midLabel);
  const roles = matched.map((p) => p.roleName);
  const arns = matched.map((p) => p.roleArn);
  const midKind = matched.every((p) => p.midKind === matched[0].midKind)
    ? matched[0].midKind
    : matched[0].midKind;

  return {
    org: uniqueOrJoin(orgs),
    repoFull: uniqueOrJoin(repos),
    midLabel: uniqueOrJoin(mids),
    midKind,
    roleName: uniqueOrJoin(roles),
    roleArn: uniqueOrJoin(arns),
    count,
    subjects,
    eventTimes,
    pathCount: matched.length,
    scope: scopeLabel(kind, sourceOrId, target, matched),
  };
}
