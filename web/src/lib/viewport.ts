/** Pan + zoom for a child canvas; wheel expands flow spacing by default. */

export type ViewportHandle = {
  reset: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  dispose: () => void;
  getScale: () => number;
};

type Options = {
  minScale?: number;
  maxScale?: number;
  step?: number;
  onChange?: (scale: number) => void;
  /**
   * Plain wheel (no Ctrl/Meta): expand/contract flow spacing instead of zoom.
   * Return false to fall through to zoom. Ctrl/Meta+wheel always zooms.
   */
  onSpacingWheel?: (direction: 1 | -1, event: WheelEvent) => boolean | void;
};

export function attachViewport(
  viewport: HTMLElement,
  canvas: HTMLElement,
  options: Options = {},
): ViewportHandle {
  const minScale = options.minScale ?? 0.4;
  const maxScale = options.maxScale ?? 3;
  const step = options.step ?? 0.15;
  const panThreshold = 4;

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let panning = false;

  const apply = () => {
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    options.onChange?.(scale);
  };

  const zoomAt = (next: number, cx: number, cy: number) => {
    const clamped = Math.min(maxScale, Math.max(minScale, next));
    if (clamped === scale) return;
    const rect = viewport.getBoundingClientRect();
    const x = cx - rect.left;
    const y = cy - rect.top;
    const wx = (x - tx) / scale;
    const wy = (y - ty) / scale;
    scale = clamped;
    tx = x - wx * scale;
    ty = y - wy * scale;
    apply();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const direction: 1 | -1 = e.deltaY > 0 ? -1 : 1;
    const wantZoom = e.ctrlKey || e.metaKey || !options.onSpacingWheel;
    if (!wantZoom && options.onSpacingWheel) {
      const handled = options.onSpacingWheel(direction, e);
      if (handled !== false) return;
    }
    zoomAt(scale * (1 + direction * step), e.clientX, e.clientY);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    pointerId = e.pointerId;
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
    panning = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (pointerId !== e.pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!panning) {
      if (Math.hypot(dx, dy) < panThreshold) return;
      panning = true;
      viewport.classList.add("is-panning");
      try {
        viewport.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    apply();
  };

  const endDrag = (e: PointerEvent) => {
    if (pointerId !== e.pointerId) return;
    pointerId = null;
    if (panning) {
      panning = false;
      viewport.classList.remove("is-panning");
      try {
        viewport.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  apply();

  return {
    reset: () => {
      scale = 1;
      tx = 0;
      ty = 0;
      apply();
    },
    zoomIn: () => {
      const rect = viewport.getBoundingClientRect();
      zoomAt(scale + step, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    zoomOut: () => {
      const rect = viewport.getBoundingClientRect();
      zoomAt(scale - step, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    dispose: () => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerup", endDrag);
      viewport.removeEventListener("pointercancel", endDrag);
    },
    getScale: () => scale,
  };
}
