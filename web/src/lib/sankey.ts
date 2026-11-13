import * as echarts from "echarts/core";
import { SankeyChart } from "echarts/charts";
import { TitleComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { PathDetail, SankeyModel } from "./aggregate";
import { detailForSelection } from "./aggregate";

echarts.use([SankeyChart, TitleComponent, TooltipComponent, CanvasRenderer]);

export type PathSelectHandler = (detail: PathDetail | null) => void;

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

const NODE_GREY = "#2e3a38";
const NODE_BORDER = "#2a9d90";

export function createSankey(
  el: HTMLElement,
  onSelect: PathSelectHandler,
): {
  render: (model: SankeyModel) => void;
  dispose: () => void;
} {
  const chart = echarts.init(el, undefined, { renderer: "canvas" });
  let lastModel: SankeyModel | null = null;

  const resolveNodeId = (ref: unknown): string => {
    if (typeof ref === "number" && lastModel) {
      return lastModel.nodes[ref]?.id ?? String(ref);
    }
    return String(ref ?? "");
  };

  chart.on("click", (params) => {
    if (!lastModel) {
      onSelect(null);
      return;
    }
    // Sankey edges: dataType edge; nodes: node (also accept missing dataType + seriesType)
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
      const data = params.data as { source?: string | number; target?: string | number };
      const source = resolveNodeId(data.source);
      const target = resolveNodeId(data.target);
      onSelect(detailForSelection(lastModel, "link", source, target));
      return;
    }
    if (isNode) {
      const data = params.data as { name?: string };
      // ECharts sankey uses `name` as node id when we set name=id
      onSelect(detailForSelection(lastModel, "node", String(data.name || "")));
      return;
    }
    onSelect(null);
  });

  const render = (model: SankeyModel) => {
    lastModel = model;
    const n = model.nodes.length;
    const canvas = el.parentElement;
    const layout = layoutMetrics(model);

    // Tall canvas when a column is dense — viewport pans/zooms over it.
    el.style.width = "100%";
    el.style.height = `${layout.height}px`;
    if (canvas) {
      canvas.style.width = "100%";
      canvas.style.height = `${layout.height}px`;
    }
    chart.resize({ width: el.clientWidth || el.offsetWidth, height: layout.height });

    if (n === 0 || model.links.length === 0) {
      chart.clear();
      chart.setOption({
        backgroundColor: "transparent",
        title: {
          text: assumesEmptyMessage(model),
          left: "center",
          top: "middle",
          textStyle: {
            color: "#f4f4f5",
            fontSize: 14,
            fontWeight: 400,
            fontFamily: "DM Sans, sans-serif",
          },
        },
      });
      return;
    }

    const idToDepth = new Map(model.nodes.map((node) => [node.id, node.depth]));
    const idToCount = new Map(model.nodes.map((node) => [node.id, node.count]));
    // Hide the noisiest labels when a column is packed; tooltip still has names.
    const labelFloor = layout.maxCol > 48 ? model.maxLinkValue * 0.08 : 0;

    const nodes = model.nodes.map((node) => ({
      name: node.id,
      depth: node.depth,
      value: node.count,
      itemStyle: {
        color: NODE_GREY,
        borderColor: NODE_BORDER,
        borderWidth: 1,
      },
      label: {
        show: node.count >= labelFloor,
        color: "#f4f4f5",
        fontFamily: "DM Sans, sans-serif",
        fontSize: layout.labelSize,
        fontWeight: 500,
        formatter: () => node.name,
      },
    }));

    const links = model.links.map((link) => ({
      source: link.source,
      target: link.target,
      value: link.value,
      lineStyle: {
        color: countToAccent(link.value, model.maxLinkValue),
        opacity: 0.7,
        curveness: 0.5,
      },
      emphasis: {
        lineStyle: {
          opacity: 0.95,
          color: countToAccent(link.value, model.maxLinkValue),
        },
      },
    }));

    chart.setOption(
      {
        backgroundColor: "transparent",
        title: undefined,
        tooltip: {
          trigger: "item",
          backgroundColor: "#121114",
          borderColor: "#202022",
          textStyle: {
            color: "#f4f4f5",
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
              const src = shortLabel(String(p.data.source || ""), model);
              const tgt = shortLabel(String(p.data.target || ""), model);
              return `<strong>${src}</strong> → <strong>${tgt}</strong><br/>assumes: ${p.data.value}`;
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
                idToCount.get(id) ?? p.value ?? 0
              }`;
            }
            return "";
          },
        },
        series: [
          {
            type: "sankey",
            emphasis: { focus: "adjacency" },
            nodeAlign: "justify",
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
              color: "#f4f4f5",
              distance: 4,
            },
          },
        ],
      },
      true,
    );
  };

  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);

  return {
    render,
    dispose: () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    },
  };
}

function layoutMetrics(model: SankeyModel): {
  maxCol: number;
  nodeGap: number;
  nodeWidth: number;
  labelSize: number;
  height: number;
} {
  const byDepth = [0, 0, 0, 0];
  for (const node of model.nodes) {
    if (node.depth >= 0 && node.depth < byDepth.length) {
      byDepth[node.depth]! += 1;
    }
  }
  const maxCol = Math.max(1, ...byDepth);
  const nodeGap = maxCol > 60 ? 2 : maxCol > 40 ? 4 : maxCol > 24 ? 8 : 14;
  const nodeWidth = maxCol > 40 ? 10 : 14;
  const labelSize = maxCol > 48 ? 9 : maxCol > 28 ? 10 : 12;
  // Enough vertical room for the densest column so links stay attached.
  const height = Math.min(14_000, Math.max(360, maxCol * (10 + nodeGap) + 64));
  return { maxCol, nodeGap, nodeWidth, labelSize, height };
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
    // repoFull:mid — take last segment
    const idx = rest.lastIndexOf(":");
    return idx >= 0 ? rest.slice(idx + 1) : rest;
  }
  return id;
}
