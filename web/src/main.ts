import "./style.css";
import type { ParsedAssume } from "./lib/githubIdentity";
import {
  CLOUDTRAIL_REGIONS,
  scanGitHubAssumes,
  type AwsCreds,
} from "./lib/cloudtrail";
import {
  buildSankey,
  buildTableRows,
  toCsv,
  uniqueOrgs,
  uniqueRoles,
  type FilterState,
  type PathDetail,
} from "./lib/aggregate";
import { createSankey } from "./lib/sankey";
import { attachViewport, type ViewportHandle } from "./lib/viewport";

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <header class="page-header">
    <h1 class="page-title">See which repos assume your roles</h1>
    <p class="lede">
      This page queries CloudTrail <code>LookupEvents</code> in
      your browser for GitHub Actions OIDC <code>AssumeRoleWithWebIdentity</code>,
      then maps <strong>org → repo → branch/env → IAM role</strong>.
    </p>
  </header>

  <section class="panel panel-collapsible" id="creds-panel" aria-labelledby="creds-title">
    <div class="panel-head">
      <h2 id="creds-title">AWS credentials</h2>
      <button
        type="button"
        class="secondary collapse-btn"
        id="creds-toggle"
        aria-expanded="true"
        aria-controls="creds-body"
      >
        Minimize
      </button>
    </div>
    <div class="panel-body" id="creds-body">
      <p class="banner" role="note">
        <strong>Credentials stay in memory only</strong> — never stored, never sent
        anywhere except <code>*.amazonaws.com</code>.
        <br>Prefer a short-lived session
        token with <code>cloudtrail:LookupEvents</code> only.
      </p>
      <form id="scan-form" class="grid-form" autocomplete="off">
        <label>
          Access key ID
          <input id="accessKeyId" name="accessKeyId" required spellcheck="false" />
        </label>
        <label>
          Secret access key
          <input id="secretAccessKey" name="secretAccessKey" type="password" required spellcheck="false" />
        </label>
        <label class="span-2">
          Session token (optional)
          <input id="sessionToken" name="sessionToken" spellcheck="false" />
        </label>
        <div class="span-2 regions-field">
          <span class="regions-label" id="regions-label">Regions</span>
          <div class="regions-dropdown" id="regions-dropdown">
            <button
              type="button"
              class="regions-trigger"
              id="regions-trigger"
              aria-haspopup="listbox"
              aria-expanded="false"
              aria-labelledby="regions-label regions-summary"
            >
              <span class="regions-summary" id="regions-summary">us-east-1</span>
              <span class="regions-chevron" aria-hidden="true">▾</span>
            </button>
            <div
              class="regions-menu"
              id="regions-menu"
              role="listbox"
              aria-multiselectable="true"
              hidden
            >
              <div class="region-actions">
                <button type="button" class="secondary btn-sm" id="regions-all">Select all</button>
                <button type="button" class="secondary btn-sm" id="regions-clear">Clear</button>
              </div>
              <div class="regions-options" id="regions-options"></div>
            </div>
          </div>
          <span class="field-hint">
            Event History is per-region — pick every region where assumes may appear.
          </span>
        </div>
        <label>
          Lookback days (1–90)
          <input id="days" name="days" type="number" min="1" max="90" value="30" required />
        </label>
        <div class="actions span-2 span-4">
          <button type="submit" class="primary" id="scan-btn">Scan CloudTrail</button>
          <button type="button" class="secondary" id="cancel-btn" disabled>Cancel</button>
          <span class="progress" id="progress" aria-live="polite"></span>
        </div>
        <p class="iam-hint span-2 span-4">
          Minimum IAM: <code>cloudtrail:LookupEvents</code> on the scan identity.
        </p>
      </form>
    </div>
  </section>

  <section class="panel panel-hero" id="results" aria-labelledby="flow-title">
    <div class="panel-head">
      <h2 id="flow-title">The Flow</h2>
    </div>
    <div class="filters" id="results-tools" hidden>
      <label>
        Branch / env column
        <select id="midStage">
          <option value="branch">Branch / tag</option>
          <option value="environment">Environment</option>
        </select>
      </label>
      <label>
        Org filter
        <select id="orgFilter"><option value="">All</option></select>
      </label>
      <label>
        Role filter
        <select id="roleFilter"><option value="">All</option></select>
      </label>
      <label>
        Min path count
        <input id="minCount" type="number" min="1" value="1" />
      </label>
      <label class="check">
        <input id="hideUnknown" type="checkbox" />
        Hide unknown workflow
      </label>
      <label class="check">
        <input id="hideUnknownMid" type="checkbox" />
        Hide unknown branch/env
      </label>
      <button type="button" class="secondary" id="export-csv" disabled>Export CSV</button>
    </div>

    <div class="sankey-shell">
      <div class="sankey-toolbar" id="sankey-toolbar" hidden>
        <button type="button" class="icon-btn secondary" id="zoom-out" aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" class="icon-btn secondary" id="zoom-in" aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" class="secondary" id="zoom-reset" aria-label="Reset view">Reset view</button>
        <span class="hint" id="zoom-label">100%</span>
        <span class="hint">Scroll = zoom · drag = pan</span>
      </div>
      <div class="sankey-viewport" id="sankey-viewport">
        <div class="flow-empty" id="flow-empty">
          <p class="flow-empty-title">No flow yet</p>
          <p class="flow-empty-copy" id="flow-empty-copy">
            Scan CloudTrail to map which repos assume your roles.
          </p>
          <button type="button" class="primary" id="flow-empty-scan">
            Go to Scan CloudTrail
          </button>
        </div>
        <div class="sankey-canvas" id="sankey-canvas" hidden>
          <div id="sankey" role="img" aria-label="Scan CloudTrail to populate the OIDC assume flow"></div>
        </div>
      </div>
      <aside class="detail" id="detail" hidden aria-live="polite"></aside>
    </div>
  </section>

  <section class="panel" id="table-panel" hidden>
    <div class="panel-head">
      <h2 id="table-title">Assumes by role × repo × branch</h2>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Count</th>
            <th>Role</th>
            <th>Repo</th>
            <th id="mid-col-header">Branch</th>
            <th>Workflows</th>
          </tr>
        </thead>
        <tbody id="table-body"></tbody>
      </table>
    </div>
  </section>

  <p class="footer-note">Research tool · credentials never leave this browser except to AWS APIs.</p>
`;

let assumes: ParsedAssume[] = [];
let didScan = false;
let abortCtrl: AbortController | null = null;
let sankey: ReturnType<typeof createSankey> | null = null;
let viewport: ViewportHandle | null = null;

const progressEl = document.querySelector<HTMLElement>("#progress")!;
const scanBtn = document.querySelector<HTMLButtonElement>("#scan-btn")!;
const cancelBtn = document.querySelector<HTMLButtonElement>("#cancel-btn")!;
const tablePanel = document.querySelector<HTMLElement>("#table-panel")!;
const tableTitle = document.querySelector<HTMLElement>("#table-title")!;
const detailEl = document.querySelector<HTMLElement>("#detail")!;
const tableBody = document.querySelector<HTMLElement>("#table-body")!;
const orgFilter = document.querySelector<HTMLSelectElement>("#orgFilter")!;
const roleFilter = document.querySelector<HTMLSelectElement>("#roleFilter")!;
const midColHeader = document.querySelector<HTMLElement>("#mid-col-header")!;
const zoomLabel = document.querySelector<HTMLElement>("#zoom-label")!;
const credsPanel = document.querySelector<HTMLElement>("#creds-panel")!;
const credsToggle = document.querySelector<HTMLButtonElement>("#creds-toggle")!;
const resultsTools = document.querySelector<HTMLElement>("#results-tools")!;
const sankeyToolbar = document.querySelector<HTMLElement>("#sankey-toolbar")!;
const flowEmpty = document.querySelector<HTMLElement>("#flow-empty")!;
const flowEmptyCopy = document.querySelector<HTMLElement>("#flow-empty-copy")!;
const sankeyCanvas = document.querySelector<HTMLElement>("#sankey-canvas")!;
const sankeyEl = document.querySelector<HTMLElement>("#sankey")!;
const exportCsvBtn = document.querySelector<HTMLButtonElement>("#export-csv")!;
const sankeyViewport = document.querySelector<HTMLElement>("#sankey-viewport")!;
const regionsDropdown = document.querySelector<HTMLElement>("#regions-dropdown")!;
const regionsTrigger = document.querySelector<HTMLButtonElement>("#regions-trigger")!;
const regionsMenu = document.querySelector<HTMLElement>("#regions-menu")!;
const regionsOptions = document.querySelector<HTMLElement>("#regions-options")!;
const regionsSummary = document.querySelector<HTMLElement>("#regions-summary")!;

const selectedRegionSet = new Set<string>(["us-east-1"]);

function populateRegions() {
  regionsOptions.innerHTML = CLOUDTRAIL_REGIONS.map((r) => {
    const checked = selectedRegionSet.has(r) ? "checked" : "";
    return `<label class="region-option">
      <input type="checkbox" value="${r}" ${checked} />
      <span>${r}</span>
    </label>`;
  }).join("");
}

function syncRegionSummary() {
  const selected = selectedRegions();
  regionsSummary.textContent = selected.length
    ? selected.join(", ")
    : "Select regions…";
  regionsSummary.classList.toggle("is-placeholder", selected.length === 0);
  regionsTrigger.classList.toggle("is-empty", selected.length === 0);
}

function selectedRegions(): string[] {
  return CLOUDTRAIL_REGIONS.filter((r) => selectedRegionSet.has(r));
}

function setRegionsOpen(open: boolean) {
  regionsMenu.hidden = !open;
  regionsTrigger.setAttribute("aria-expanded", open ? "true" : "false");
  regionsDropdown.classList.toggle("is-open", open);
}

populateRegions();
syncRegionSummary();

regionsOptions.addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement | null;
  if (!input || input.type !== "checkbox") return;
  if (input.checked) selectedRegionSet.add(input.value);
  else selectedRegionSet.delete(input.value);
  syncRegionSummary();
});

regionsTrigger.addEventListener("click", () => {
  setRegionsOpen(regionsMenu.hasAttribute("hidden"));
});

document.querySelector("#regions-all")!.addEventListener("click", () => {
  for (const r of CLOUDTRAIL_REGIONS) selectedRegionSet.add(r);
  for (const input of regionsOptions.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  )) {
    input.checked = true;
  }
  syncRegionSummary();
});

document.querySelector("#regions-clear")!.addEventListener("click", () => {
  selectedRegionSet.clear();
  for (const input of regionsOptions.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  )) {
    input.checked = false;
  }
  syncRegionSummary();
});

document.addEventListener("click", (ev) => {
  if (!regionsMenu.hidden && !regionsDropdown.contains(ev.target as Node)) {
    setRegionsOpen(false);
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !regionsMenu.hidden) {
    setRegionsOpen(false);
    regionsTrigger.focus();
  }
});

function setCredsCollapsed(collapsed: boolean) {
  credsPanel.classList.toggle("is-collapsed", collapsed);
  credsToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  credsToggle.textContent = collapsed ? "Expand" : "Minimize";
}

credsToggle.addEventListener("click", () => {
  setCredsCollapsed(!credsPanel.classList.contains("is-collapsed"));
});

function focusScanForm() {
  setCredsCollapsed(false);
  credsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  const key = document.querySelector<HTMLInputElement>("#accessKeyId")!;
  key.focus();
}

document.querySelector("#flow-empty-scan")!.addEventListener("click", () => {
  focusScanForm();
});

function setResultsChrome(hasData: boolean) {
  resultsTools.hidden = !hasData;
  sankeyToolbar.hidden = !hasData;
  detailEl.hidden = !hasData;
  flowEmpty.hidden = hasData;
  sankeyCanvas.hidden = !hasData;
  exportCsvBtn.disabled = !hasData;
  sankeyViewport.classList.toggle("is-empty", !hasData);
  sankeyViewport.classList.toggle("is-interactive", hasData);

  if (!hasData) {
    flowEmptyCopy.textContent = didScan
      ? "No GitHub OIDC assumes in this window/regions. Adjust regions or lookback, then scan again."
      : "Scan CloudTrail to map which repos assume your roles.";
    sankeyEl.setAttribute(
      "aria-label",
      didScan
        ? "No GitHub OIDC assumes found for this scan"
        : "Scan CloudTrail to populate the OIDC assume flow",
    );
  } else {
    sankeyEl.setAttribute(
      "aria-label",
      "OIDC assume Sankey diagram. Scroll to zoom, drag to pan. Click a flow or node for detail.",
    );
  }
}

function setProgress(msg: string, kind: "" | "error" | "ok" = "") {
  progressEl.textContent = msg;
  progressEl.className = `progress${kind ? ` ${kind}` : ""}`;
}

function readFilters(): FilterState {
  return {
    org: orgFilter.value,
    role: roleFilter.value,
    minCount: Math.max(
      1,
      Number(document.querySelector<HTMLInputElement>("#minCount")!.value) || 1,
    ),
    hideUnknownWorkflow:
      document.querySelector<HTMLInputElement>("#hideUnknown")!.checked,
    hideUnknownMid:
      document.querySelector<HTMLInputElement>("#hideUnknownMid")!.checked,
    midStage: document.querySelector<HTMLSelectElement>("#midStage")!
      .value as FilterState["midStage"],
  };
}

function fillFilterOptions() {
  const orgs = uniqueOrgs(assumes);
  const roles = uniqueRoles(assumes);
  const keepOrg = orgFilter.value;
  const keepRole = roleFilter.value;
  orgFilter.innerHTML =
    `<option value="">All</option>` +
    orgs
      .map((o) => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`)
      .join("");
  roleFilter.innerHTML =
    `<option value="">All</option>` +
    roles
      .map((r) => `<option value="${escapeAttr(r)}">${escapeHtml(r)}</option>`)
      .join("");
  if (orgs.includes(keepOrg)) orgFilter.value = keepOrg;
  if (roles.includes(keepRole)) roleFilter.value = keepRole;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function shortRepo(repoFull: string): string {
  const i = repoFull.lastIndexOf("/");
  return i >= 0 ? repoFull.slice(i + 1) : repoFull;
}

function ensureChart() {
  if (!sankey) {
    const el = document.querySelector<HTMLElement>("#sankey")!;
    sankey = createSankey(el, renderDetail);
  }
  if (!viewport) {
    const vp = document.querySelector<HTMLElement>("#sankey-viewport")!;
    const canvas = document.querySelector<HTMLElement>("#sankey-canvas")!;
    viewport = attachViewport(vp, canvas, {
      minScale: 0.15,
      maxScale: 4,
      onChange: (scale) => {
        zoomLabel.textContent = `${Math.round(scale * 100)}%`;
      },
    });
  }
}

function setTruncationNote(
  truncation:
    | {
        midsCollapsed: number;
        rolesCollapsed: number;
        reposCollapsed: number;
      }
    | undefined,
) {
  let note = document.querySelector<HTMLElement>("#sankey-truncation");
  if (!truncation) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement("p");
    note.id = "sankey-truncation";
    note.className = "sankey-truncation";
    sankeyToolbar.appendChild(note);
  }
  const bits: string[] = [];
  if (truncation.reposCollapsed) {
    bits.push(`${truncation.reposCollapsed} repos → other`);
  }
  if (truncation.midsCollapsed) {
    bits.push(`${truncation.midsCollapsed} branch/env → other`);
  }
  if (truncation.rolesCollapsed) {
    bits.push(`${truncation.rolesCollapsed} roles → other`);
  }
  note.textContent = `Large graph capped for layout (${bits.join("; ")}). Raise min path count or filter to focus. Zoom out / pan to explore.`;
}

function renderDetail(detail: PathDetail | null) {
  if (!assumes.length) {
    detailEl.innerHTML = "";
    return;
  }
  if (!detail) {
    detailEl.innerHTML = `<p class="empty">Click a flow or node for path detail.</p>`;
    return;
  }
  const midTitle =
    detail.midKind === "branch" ? "Branch" : "Environment";
  const workflows = [...detail.workflows.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `<li><code>${escapeHtml(n)}</code> — ${c}</li>`)
    .join("");
  const subjects = detail.subjects
    .map((s) => `<li><code>${escapeHtml(s)}</code></li>`)
    .join("");
  const times = detail.eventTimes
    .slice(0, 8)
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join("");
  const title =
    detail.pathCount > 1
      ? `${detail.org} · ${detail.pathCount} paths`
      : `${detail.org} / ${shortRepo(detail.repoFull)}`;

  detailEl.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <dl>
      <dt>Assumes</dt><dd>${detail.count}</dd>
      <dt>Paths</dt><dd>${detail.pathCount}</dd>
      <dt>Org</dt><dd>${escapeHtml(detail.org)}</dd>
      <dt>Repo</dt><dd>${escapeHtml(detail.repoFull)}</dd>
      <dt>${midTitle}</dt><dd>${escapeHtml(detail.midLabel)}</dd>
      <dt>Role</dt><dd>${escapeHtml(detail.roleName)}</dd>
      <dt>Role ARN</dt><dd>${escapeHtml(detail.roleArn)}</dd>
    </dl>
    <p class="section-label">Workflows</p>
    <ul>${workflows || "<li class='empty'>none parsed</li>"}</ul>
    <p class="section-label">Subjects (sample)</p>
    <ul>${subjects || "<li class='empty'>none</li>"}</ul>
    <p class="section-label">Event times (sample)</p>
    <ul>${times || "<li class='empty'>none</li>"}</ul>
  `;
}

type RenderOpts = {
  /** While scanning: keep viewport, do not wipe detail selection. */
  incremental?: boolean;
};

let liveRenderTimer: number | null = null;
let liveRenderPending = false;
let revealedLiveResults = false;

function renderAll(opts: RenderOpts = {}) {
  const incremental = Boolean(opts.incremental);
  const filters = readFilters();
  const midLabel = filters.midStage === "branch" ? "Branch" : "Environment";
  midColHeader.textContent = midLabel;
  tableTitle.textContent = `Assumes by role × repo × ${midLabel.toLowerCase()}`;

  if (!assumes.length) {
    setResultsChrome(false);
    tablePanel.hidden = true;
    setTruncationNote(undefined);
    if (sankey) {
      sankey.render({ nodes: [], links: [], paths: new Map(), maxLinkValue: 1 });
    }
    renderDetail(null);
    return;
  }

  const firstReveal = !revealedLiveResults;
  setResultsChrome(true);
  ensureChart();
  tablePanel.hidden = false;
  const model = buildSankey(assumes, filters);
  const tableRows = buildTableRows(assumes, filters);
  sankey!.render(model);
  setTruncationNote(model.truncation);
  if (!incremental) {
    renderDetail(null);
    viewport?.reset();
  } else if (firstReveal) {
    renderDetail(null);
    viewport?.reset();
  }
  revealedLiveResults = true;

  tableBody.innerHTML = tableRows.length
    ? tableRows
        .map(
          (r) => `
      <tr>
        <td>${r.count}</td>
        <td><code>${escapeHtml(r.roleName)}</code></td>
        <td><code>${escapeHtml(r.repoFull)}</code></td>
        <td><code>${escapeHtml(r.mid)}</code></td>
        <td>${escapeHtml(r.workflows)}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="empty">No rows match current filters.</td></tr>`;
}

/** Throttle live Sankey updates so ECharts is not rebuilt every page. */
function scheduleLiveRender() {
  liveRenderPending = true;
  if (liveRenderTimer != null) return;
  liveRenderTimer = window.setTimeout(() => {
    liveRenderTimer = null;
    if (!liveRenderPending) return;
    liveRenderPending = false;
    fillFilterOptions();
    renderAll({ incremental: true });
  }, 400);
}

function flushLiveRender() {
  if (liveRenderTimer != null) {
    clearTimeout(liveRenderTimer);
    liveRenderTimer = null;
  }
  liveRenderPending = false;
  fillFilterOptions();
  renderAll({ incremental: true });
}

// Initial empty chart
renderAll();

document.querySelector("#zoom-in")!.addEventListener("click", () => {
  ensureChart();
  viewport?.zoomIn();
});
document.querySelector("#zoom-out")!.addEventListener("click", () => {
  ensureChart();
  viewport?.zoomOut();
});
document.querySelector("#zoom-reset")!.addEventListener("click", () => {
  ensureChart();
  viewport?.reset();
});

document.querySelector("#scan-form")!.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const regions = selectedRegions();
  if (!regions.length) {
    setProgress("Select at least one region.", "error");
    return;
  }

  const creds: AwsCreds = {
    accessKeyId: document
      .querySelector<HTMLInputElement>("#accessKeyId")!
      .value.trim(),
    secretAccessKey: document
      .querySelector<HTMLInputElement>("#secretAccessKey")!
      .value.trim(),
    sessionToken:
      document.querySelector<HTMLInputElement>("#sessionToken")!.value.trim() ||
      undefined,
  };
  const days =
    Number(document.querySelector<HTMLInputElement>("#days")!.value) || 30;

  abortCtrl?.abort();
  abortCtrl = new AbortController();
  scanBtn.disabled = true;
  cancelBtn.disabled = false;
  revealedLiveResults = false;
  assumes = [];
  renderAll();
  setProgress(`Starting ${regions.length} region(s)…`);

  try {
    assumes = await scanGitHubAssumes(creds, {
      days,
      regions,
      signal: abortCtrl.signal,
      onProgress: (p) => {
        const scope =
          p.region && p.regionTotal
            ? ` [${p.regionIndex}/${p.regionTotal}]`
            : "";
        setProgress(
          `${p.status}${scope} · pages=${p.pages} raw=${p.rawEvents} github=${p.githubEvents}`,
        );
      },
      onBatch: (_batch, allSoFar) => {
        assumes = allSoFar as ParsedAssume[];
        const firstData = !revealedLiveResults && assumes.length > 0;
        if (firstData) {
          // Immediate first paint so the Flow appears as soon as we have rows.
          flushLiveRender();
          setCredsCollapsed(true);
          document
            .querySelector("#results")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          scheduleLiveRender();
        }
      },
    });
    didScan = true;
    flushLiveRender();
    setProgress(
      assumes.length
        ? `Found ${assumes.length} GitHub OIDC assume event(s) across ${regions.length} region(s).`
        : "Scan finished — no GitHub OIDC assumes in this window/regions.",
      assumes.length ? "ok" : "",
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      didScan = true;
      flushLiveRender();
      setProgress(
        assumes.length
          ? `Cancelled — showing ${assumes.length} assume(s) collected so far.`
          : "Cancelled.",
        assumes.length ? "ok" : "",
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = /AccessDenied|not authorized|Unauthorized/i.test(msg)
        ? " — grant cloudtrail:LookupEvents on this identity."
        : "";
      setProgress(`Error: ${msg}${hint}`, "error");
      if (assumes.length) flushLiveRender();
    }
  } finally {
    scanBtn.disabled = false;
    cancelBtn.disabled = true;
    abortCtrl = null;
  }
});

cancelBtn.addEventListener("click", () => {
  abortCtrl?.abort();
});

for (const id of [
  "midStage",
  "orgFilter",
  "roleFilter",
  "minCount",
  "hideUnknown",
  "hideUnknownMid",
]) {
  document.querySelector(`#${id}`)!.addEventListener("change", () => renderAll());
}

exportCsvBtn.addEventListener("click", () => {
  if (!assumes.length) return;
  const filters = readFilters();
  const csv = toCsv(buildTableRows(assumes, filters), filters.midStage);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "github-oidc-cloudtrail-assumes.csv";
  a.click();
  URL.revokeObjectURL(url);
});

window.addEventListener("resize", () => {
  // ECharts listens internally; also reflow after CSS viewport changes
  const el = document.querySelector<HTMLElement>("#sankey");
  if (el && sankey) {
    // trigger resize via re-render of current model only when we have assumes
    if (assumes.length) {
      sankey.render(buildSankey(assumes, readFilters()));
    }
  }
});
