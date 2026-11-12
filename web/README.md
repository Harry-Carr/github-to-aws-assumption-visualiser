# GitHub OIDC CloudTrail heatmap (web)

Vite + TypeScript SPA. No backend — AWS SDK v3 runs in the browser.

```bash
npm install
npm run dev       # local UI
npm run build     # → dist/ (relative asset paths for GitHub Pages)
npm run preview
npm run test:parse
```

## GitHub Pages

Build uses `base: './'` so assets resolve under project sites (`https://<user>.github.io/<repo>/`) and user/org root sites. `public/.nojekyll` is copied into `dist/` so Jekyll does not touch the publish tree.

From the **repo root** (this package’s parent), workflow [`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml) builds `web/` and deploys with GitHub Actions Pages.

One-time setup in the GitHub repo:

1. **Settings → Pages → Build and deployment → Source:** GitHub Actions
2. Push to `main`/`master` (or run the workflow manually)

Trust note: anyone who can change the published JS can change what happens with pasted credentials. Prefer short-lived session tokens; only use a Pages URL you trust.

Source:

| Path | Role |
|------|------|
| `src/main.ts` | UI wiring |
| `src/lib/cloudtrail.ts` | `LookupEvents` pagination |
| `src/lib/githubIdentity.ts` | Parse GitHub OIDC from events |
| `src/lib/aggregate.ts` | Sankey model / table / CSV |
| `src/lib/sankey.ts` | ECharts Sankey (flow width + teal by count) |
