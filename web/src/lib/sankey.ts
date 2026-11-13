import * as echarts from "echarts/core";
import { SankeyChart } from "echarts/charts";
import { TitleComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { PathDetail, SankeyModel } from "./aggregate";
import { detailForSelection, graphKeysForSelection } from "./aggregate";

echarts.use([SankeyChart, TitleComponent, TooltipComponent, CanvasRenderer]);

export type SankeySelection = {
  kind: "node" | "link";
  sourceOrId: string;
  target?: string;
};

export type PathSelectHandler = (
  detail: PathDetail | null,
  selection: SankeySelection | null,
) => void;

export type SankeyRenderOptions = {
  /**
   * Vertical spacing multiplier (1 = compact, higher = taller chart / more
   * separation between small flows). Driven by scroll-to-expand.
   */
  spacing?: number;
  /** When set (including null), syncs click-highlight state from the host. */
  selection?: SankeySelection | null;
};

/**
 * Link strength → accent teal depth (--accent #3ed6c6).
 * Low = muted teal-slate; high = saturated accent.
 */
export function countToAccent(count: number, maxCount: number): string {
  const t = maxCount <= 0 ? 0 : Math.min(1, Math.max(0, count / maxCount));
  const e = Math.pow(t, 0.65);
  // #2a3f3d → #3ed6c6
  const r = Math.round(42 + e * (62 - 42));
  const g = Math.round(63 + e * (214 - 63));
  const b = Math.round(61 + e * (198 - 61));
  return `rgb(${r},${g},${b})`;
}

const ACCENT = "#3ed6c6";
const NODE_GREY = "#2e3a38";
const NODE_ACTIVE = "#3a5c58";
const NODE_DIM = "#1c2221";
const LINK_DIM = "#2a3332";
const LABEL_DIM = "#6b7280";
const LABEL_ON = "#f4f4f5";

export function createSankey(
  el: HTMLElement,
  onSelect: PathSelectHandler,
): {
  render: (model: SankeyModel, opts?: SankeyRenderOptions) => void;
  clearSelection: () => void;
  dispose: () => void;
} {
  const chart = echarts.init(el, undefined, { renderer: "canvas" });
  let lastModel: SankeyModel | null = null;
  let lastSpacing = 1;
  let activeSelection: SankeySelection | null = null;

  const resolveNodeId = (ref: unknown): string => {
    if (typeof ref === "number" && lastModel) {
      return lastModel.nodes[ref]?.id ?? String(ref);
    }
    return String(ref ?? "");
  };

  const notify = (selection: SankeySelection | null) => {
    if (!selection || !lastModel) {
      onSelect(null, null);
      return;
    }
    onSelect(
      detailForSelection(
        lastModel,
        selection.kind,
        selection.sourceOrId,
        selection.target,
      ),
      selection,
    );
  };

  const setSelection = (selection: SankeySelection | null, emit: boolean) => {
    activeSelection = selection;
    if (lastModel) paint(lastModel, lastSpacing);
    if (emit) notify(selection);
  };

  chart.on("click", (params) => {
    if (!lastModel) {
      setSelection(null, true);
      return;
    }
    const isEdge =
      params.dataType === "edge" ||
      (params.seriesType === "sankey" &&
        params.data &&
        typeof params.data === "object" &&
        "source" in (params.data as object) &&
        "target" in (params.data as object));
    const isNode =
      params.dataType === "node" ||
      (params.seriesType === "sankey" &&
        params.data &&
        typeof params.data === "object" &&
        "name" in (params.data as object) &&
        !("source" in (params.data as object)));

    if (isEdge) {
      const data = params.data as {
        source?: string | number;
        target?: string | number;
      };
      const source = resolveNodeId(data.source);
      const target = resolveNodeId(data.target);
      setSelection({ kind: "link", sourceOrId: source, target }, true);
      return;
    }
    if (isNode) {
      const data = params.data as { name?: string };
      const id = String(data.name || "");
      setSelection({ kind: "node", sourceOrId: id }, true);
      return;
    }
    setSelection(null, true);
  });

  // Blank chart area → clear highlight (series click has a target).
  chart.getZr().on("click", (e) => {
    if (e.target) return;
    if (!activeSelection) return;
    setSelection(null, true);
  });

  const paint = (model: SankeyModel, spacing: number) => {
    const n = model.nodes.length;
    const canvas = el.parentElement;
    const layout = layoutMetrics(model, spacing);
    const viewportW = canvas?.parentElement?.clientWidth || 0;
    const width = Math.max(viewportW, layout.width);

    el.style.width = `${width}px`;
    el.style.height = `${layout.height}px`;
    if (canvas) {
      canvas.style.width = `${width}px`;
      canvas.style.height = `${layout.height}px`;
    }
    chart.resize({
      width,
      height: layout.height,
    });

    if (n === 0 || model.links.length === 0) {
      activeSelection = null;
      chart.clear();
      chart.setOption({
        backgroundColor: "transparent",
        title: {
          text: assumesEmptyMessage(model),
          left: "center",
          top: "middle",
          textStyle: {
            color: LABEL_ON,
            fontSize: 14,
            fontWeight: 400,
            fontFamily: "DM Sans, sans-serif",
          },
        },
      });
      return;
    }

    // Drop stale selection if it no longer matches anything.
    let highlight: { linkKeys: Set<string>; nodeIds: Set<string> } | null =
      null;
    if (activeSelection) {
      highlight = graphKeysForSelection(
        model,
        activeSelection.kind,
        activeSelection.sourceOrId,
        activeSelection.target,
      );
      if (!highlight.linkKeys.size && !highlight.nodeIds.size) {
        activeSelection = null;
        highlight = null;
      }
    }

    const idToDepth = new Map(model.nodes.map((node) => [node.id, node.depth]));
    const idToCount = new Map(model.nodes.map((node) => [node.id, node.count]));
    const linkCount = new Map(
      model.links.map((l) => [`${l.source}\0${l.target}`, l.value] as const),
    );
    const labelFloor =
      layout.maxCol > 48 ? model.maxLinkValue * 0.08 : 0;
    const focused = Boolean(highlight);

    const nodes = model.nodes.map((node) => {
      const on = !focused || highlight!.nodeIds.has(node.id);
      return {
        name: node.id,
        depth: node.depth,
        value: Math.max(1, node.count),
        itemStyle: {
          color: on ? (focused ? NODE_ACTIVE : NODE_GREY) : NODE_DIM,
          borderWidth: 0,
          opacity: on ? 1 : 0.35,
        },
        label: {
          show: node.count >= labelFloor || spacing >= 1.5,
          color: on ? LABEL_ON : LABEL_DIM,
          fontFamily: "DM Sans, sans-serif",
          fontSize: layout.labelSize,
          fontWeight: on && focused ? 600 : 500,
          formatter: () => node.name,
        },
      };
    });

    const links = model.links.map((link) => {
      const key = `${link.source}\0${link.target}`;
      const on = !focused || highlight!.linkKeys.has(key);
      const base = countToAccent(link.value, model.maxLinkValue);
      return {
        source: link.source,
        target: link.target,
        value: Math.max(1, link.value),
        lineStyle: {
          color: on ? (focused ? ACCENT : base) : LINK_DIM,
          opacity: on ? (focused ? 0.95 : 0.72) : 0.12,
          curveness: 0.5,
        },
        emphasis: {
          lineStyle: {
            opacity: on ? 0.98 : 0.2,
            color: on ? ACCENT : LINK_DIM,
          },
        },
      };
    });

    chart.setOption(
      {
        backgroundColor: "transparent",
        title: undefined,
        tooltip: {
          trigger: "item",
          backgroundColor: "#121114",
          borderColor: "#202022",
          textStyle: {
            color: LABEL_ON,
            fontFamily: "DM Sans, sans-serif",
          },
          formatter: (p: {
            dataType?: string;
            name?: string;
            value?: number;
            data?: {
              source?: string;
              target?: string;
              value?: number;
              name?: string;
            };
          }) => {
            if (p.dataType === "edge" && p.data) {
              const srcId = resolveNodeId(p.data.source);
              const tgtId = resolveNodeId(p.data.target);
              const real =
                linkCount.get(`${srcId}\0${tgtId}`) ?? p.data.value ?? 0;
              const src = shortLabel(srcId, model);
              const tgt = shortLabel(tgtId, model);
              return `<strong>${src}</strong> → <strong>${tgt}</strong><br/>assumes: ${real}`;
            }
            if (p.dataType === "node") {
              const id = String(p.data?.name || p.name || "");
              const depth = idToDepth.get(id);
              const stage =
                depth === 0
                  ? "Org"
                  : depth === 1
                    ? "Repo"
                    : depth === 2
                      ? "Branch / env"
                      : "IAM role";
              return `<strong>${shortLabel(id, model)}</strong><br/>${stage}<br/>assumes: ${
                idToCount.get(id) ?? 0
              }`;
            }
            return "";
          },
        },
        series: [
          {
            type: "sankey",
            emphasis: { focus: focused ? "none" : "adjacency" },
            blur: {
              itemStyle: { opacity: 0.2 },
              lineStyle: { opacity: 0.08 },
            },
            nodeAlign: "justify",
            left: layout.padLeft,
            right: layout.padRight,
            top: 16,
            bottom: 16,
            nodeGap: layout.nodeGap,
            nodeWidth: layout.nodeWidth,
            layoutIterations: layout.maxCol > 40 ? 32 : 64,
            draggable: false,
            data: nodes,
            links,
            lineStyle: { curveness: 0.5 },
            label: {
              position: "right",
              fontFamily: "DM Sans, sans-serif",
              fontSize: layout.labelSize,
              fontWeight: 500,
              color: LABEL_ON,
              distance: 6,
              overflow: "truncate",
              width: Math.max(64, layout.padRight - 16),
              ellipsis: "…",
            },
          },
        ],
      },
      true,
    );
  };

  const render = (model: SankeyModel, opts: SankeyRenderOptions = {}) => {
    lastModel = model;
    lastSpacing = Math.max(1, opts.spacing ?? lastSpacing);
    if (opts.selection !== undefined) {
      activeSelection = opts.selection;
    }
    paint(model, lastSpacing);
  };

  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);

  return {
    render,
    /** Clear highlight only (no onSelect). Use after main already reset UI state. */
    clearSelection: () => {
      if (!activeSelection) return;
      setSelection(null, false);
    },
    dispose: () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    },
  };
}

function layoutMetrics(
  model: SankeyModel,
  spacing: number,
): {
  maxCol: number;
  nodeGap: number;
  nodeWidth: number;
  labelSize: number;
  height: number;
  width: number;
  padLeft: number;
  padRight: number;
} {
  const byDepth = [0, 0, 0, 0];
  for (const node of model.nodes) {
    if (node.depth >= 0 && node.depth < byDepth.length) {
      byDepth[node.depth]! += 1;
    }
  }
  const maxCol = Math.max(1, ...byDepth);
  const baseGap = maxCol > 60 ? 2 : maxCol > 40 ? 4 : maxCol > 24 ? 8 : 14;
  // Scroll-expand grows gap + slot height so small flows separate.
  const nodeGap = Math.max(2, Math.round(baseGap * Math.min(spacing, 3)));
  const slot = (10 + baseGap) * spacing;
  const labelSize =
    spacing >= 2 ? 12 : maxCol > 48 ? 9 : maxCol > 28 ? 10 : 12;
  const height = Math.min(
    24_000,
    Math.max(360, Math.round(maxCol * slot + 64)),
  );
  // Right gutter sized for longest role/repo label (labels sit to the right).
  const maxNameLen = Math.max(
    8,
    ...model.nodes.map((n) => n.name.length),
  );
  const padRight = Math.min(
    420,
    Math.max(140, Math.round(maxNameLen * labelSize * 0.62 + 24)),
  );
  const padLeft = 20;
  // Width tracks height so tall graphs stay proportionate; include label gutter
  // so column area is not stolen by padRight.
  const width = Math.min(
    14_000,
    Math.max(
      720,
      Math.round(height * 0.92 + spacing * 120) + padLeft + padRight,
    ),
  );
  const nodeWidth =
    width > 2200 ? 22 : width > 1400 ? 18 : maxCol > 40 ? 10 : 14;
  return {
    maxCol,
    nodeGap,
    nodeWidth,
    labelSize,
    height,
    width,
    padLeft,
    padRight,
  };
}

function assumesEmptyMessage(model: SankeyModel): string {
  if (!model.nodes.length && !model.links.length) {
    return "Scan CloudTrail to populate the flow";
  }
  return "No flows match current filters";
}

function shortLabel(id: string, model: SankeyModel): string {
  const node = model.nodes.find((n) => n.id === id);
  if (node) return node.name;
  if (id.startsWith("org:")) return id.slice(4);
  if (id.startsWith("repo:")) {
    const full = id.slice(5);
    const i = full.lastIndexOf("/");
    return i >= 0 ? full.slice(i + 1) : full;
  }
  if (id.startsWith("role:")) return id.slice(5);
  if (id.startsWith("branch:") || id.startsWith("environment:")) {
    const rest = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
    const idx = rest.lastIndexOf(":");
    return idx >= 0 ? rest.slice(idx + 1) : rest;
  }
  return id;
}
