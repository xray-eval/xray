<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import DefaultTheme from "vitepress/theme";

// Mermaid diagrams render inline as a clickable overview; clicking opens a
// fullscreen viewer with wheel-zoom (toward the cursor), drag-to-pan, +/-/Fit
// controls, and Esc to close — the GitHub-style "open the diagram to read it"
// UX. Hand-rolled (no pan/zoom dependency); all DOM work is client-only inside
// onMounted, so SSR is untouched.
const { Layout } = DefaultTheme;

let teardown: (() => void) | undefined;

onMounted(() => {
  const root = document.documentElement;

  const overlay = document.createElement("div");
  overlay.className = "mermaid-zoom";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="mz-stage" data-stage>
      <div class="mz-canvas" data-canvas></div>
    </div>
    <div class="mz-bar" role="toolbar" aria-label="Diagram zoom controls">
      <button type="button" data-act="out" aria-label="Zoom out" title="Zoom out">–</button>
      <button type="button" data-act="reset" aria-label="Fit to screen" title="Fit to screen">Fit</button>
      <button type="button" data-act="in" aria-label="Zoom in" title="Zoom in">+</button>
      <button type="button" data-act="close" aria-label="Close (Esc)" title="Close (Esc)">✕</button>
    </div>`;
  document.body.appendChild(overlay);

  const stage = overlay.querySelector<HTMLElement>("[data-stage]");
  const canvas = overlay.querySelector<HTMLElement>("[data-canvas]");
  const bar = overlay.querySelector<HTMLElement>(".mz-bar");
  if (!stage || !canvas || !bar) return;

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let natW = 0;
  let natH = 0;

  const clamp = (s: number) => Math.min(12, Math.max(0.1, s));
  const draw = () => {
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const fit = () => {
    const r = stage.getBoundingClientRect();
    if (!natW || !natH) return;
    scale = clamp(Math.min((r.width * 0.92) / natW, (r.height * 0.92) / natH));
    tx = (r.width - natW * scale) / 2;
    ty = (r.height - natH * scale) / 2;
    draw();
  };

  const zoomTo = (next: number, cx: number, cy: number) => {
    const s = clamp(next);
    const k = s / scale;
    tx = cx - (cx - tx) * k;
    ty = cy - (cy - ty) * k;
    scale = s;
    draw();
  };
  const center = () => {
    const r = stage.getBoundingClientRect();
    return { cx: r.width / 2, cy: r.height / 2 };
  };

  const open = (svg: SVGSVGElement) => {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const vb = svg.viewBox?.baseVal;
    const rect = svg.getBoundingClientRect();
    natW = vb && vb.width ? vb.width : rect.width;
    natH = vb && vb.height ? vb.height : rect.height;
    clone.removeAttribute("style");
    clone.style.width = `${natW}px`;
    clone.style.height = `${natH}px`;
    clone.style.maxWidth = "none";
    canvas.replaceChildren(clone);
    overlay.hidden = false;
    root.classList.add("mz-open");
    fit();
  };
  const close = () => {
    overlay.hidden = true;
    root.classList.remove("mz-open");
    canvas.replaceChildren();
  };

  const onDocClick = (e: MouseEvent) => {
    if (!overlay.hidden) return;
    const target = e.target instanceof Element ? e.target : null;
    const box = target?.closest(".vp-doc .mermaid");
    const svg = box?.querySelector("svg");
    if (svg) {
      e.preventDefault();
      open(svg as unknown as SVGSVGElement);
    }
  };
  const onBarClick = (e: MouseEvent) => {
    const btn = e.target instanceof Element ? e.target.closest("button") : null;
    const act = btn?.dataset.act;
    if (!act) return;
    const { cx, cy } = center();
    if (act === "in") zoomTo(scale * 1.3, cx, cy);
    else if (act === "out") zoomTo(scale / 1.3, cx, cy);
    else if (act === "reset") fit();
    else if (act === "close") close();
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomTo(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - r.left, e.clientY - r.top);
  };

  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;
  const onPointerDown = (e: PointerEvent) => {
    if (e.target instanceof Element && e.target.closest(".mz-bar")) return;
    dragging = true;
    moved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("mz-dragging");
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    tx += dx;
    ty += dy;
    lastX = e.clientX;
    lastY = e.clientY;
    draw();
  };
  const onPointerUp = (e: PointerEvent) => {
    dragging = false;
    stage.classList.remove("mz-dragging");
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  };
  // Click on empty backdrop closes — but not when the click ended a pan.
  const onStageClick = (e: MouseEvent) => {
    if (e.target === stage && !moved) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (overlay.hidden) return;
    const { cx, cy } = center();
    if (e.key === "Escape") close();
    else if (e.key === "+" || e.key === "=") zoomTo(scale * 1.3, cx, cy);
    else if (e.key === "-") zoomTo(scale / 1.3, cx, cy);
  };
  const onResize = () => {
    if (!overlay.hidden) fit();
  };

  document.addEventListener("click", onDocClick);
  bar.addEventListener("click", onBarClick);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("click", onStageClick);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);

  teardown = () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    overlay.remove();
    root.classList.remove("mz-open");
  };
});

onUnmounted(() => teardown?.());
</script>

<template>
  <Layout />
</template>
