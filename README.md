# GitHub OIDC CloudTrail flow

Browser app that queries AWS CloudTrail for GitHub Actions OIDC assumes and draws a **Sankey** of org → repo → branch/env → IAM role (thicker / deeper teal = more assumes). Vite + TypeScript SPA under [`web/`](web/) — no backend; AWS SDK v3 runs in the browser.

## Quick start

```bash
cd web
npm install
npm run dev
```

Open the printed local URL. Provide:

| Field | Notes |
|-------|--------|
| Access key / secret | Or paste temporary keys from `aws sts assume-role` |
| Session token | Optional; recommended |
| Regions | Dropdown multi-select (comma-separated summary); CloudTrail **Event History is regional** — pick every region where events may appear |
| Lookback days | 1–90 (API limit ~90 days) |

Credentials stay in memory only and are sent only to `*.amazonaws.com`. Prefer a short-lived session token.

Then **Scan CloudTrail**. The app:

1. Paginates `LookupEvents` for `AssumeRoleWithWebIdentity` in each selected region
2. Keeps events from `token.actions.githubusercontent.com` (GitHub OIDC)
3. Aggregates by org/repo × branch/env × role
4. Streams pages into a live ECharts Sankey (`org → repo → branch|env → role`) as assumes arrive; branch/env column toggle; org/repo wildcard filters (`platform*`, `security*`); click for detail; export CSV

```bash
npm run build     # → web/dist (relative asset paths for GitHub Pages)
npm run preview   # serve the build locally
npm run test:parse
```

## GitHub Pages

Vite `base` is `./` so the build works under `https://<user>.github.io/<repo>/`. Workflow [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) builds `web/` and publishes via **Actions → Pages**.

Enable once: repo **Settings → Pages → Source: GitHub Actions**.

Treat the hosted page like any third-party site when pasting AWS credentials — use short-lived tokens only.

## IAM

Minimum for the scan identity:

```json
{
  "Effect": "Allow",
  "Action": ["cloudtrail:LookupEvents"],
  "Resource": "*"
}
```

## Limits

- `LookupEvents` throttles easily (often HTTP 400 `Rate exceeded`). The scanner paces pages (~350ms), backs off with retries + jitter on throttle, and pauses between regions. Progress shows retry waits; Cancel still aborts mid-backoff.
- Roles appear only if they were **assumed** in the lookback window (no IAM ListRoles in v1).
- Large graphs cap rare repos / branch-env values / roles into **other** buckets. Flow thickness uses raw assume counts (so bands fill each node); **scroll** over the chart expands vertical spacing (Ctrl/Cmd+scroll zooms; drag pans).
- Click a Sankey node or flow to focus the bottom list on those leaf paths (`repo → branch/env → role`); **Show all flows** clears the selection.
- Do not paste long-lived keys into a page you do not host/trust.

## Layout

| Path | Purpose |
|------|---------|
| `web/` | Vite + TypeScript SPA (source, `public/`, package manifests) |
| `.github/workflows/` | GitHub Pages build + deploy |
