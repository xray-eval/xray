<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
// The tiny build ships as a classic script that assigns `globalThis.mermaid`;
// imported as an ES module its top-level `var` would be module-scoped and the
// global would never be set. Load it as a static asset through a <script> tag.
import mermaidUrl from "@mermaid-js/tiny/dist/mermaid.tiny.js?url";

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

const props = defineProps<{ id: string; graph: string }>();
const svg = ref("");

// Rendering at natural size (no useMaxWidth) lets wide diagrams scroll in
// their panel; SVG <text> labels instead of HTML <foreignObject> keep the
// geometry intact when Layout.vue clones the SVG into the fullscreen viewer.
// mermaid 12 changed the defaults to theme "redux-color", look "neo" and the
// ELK layout — and the tiny build does not bundle ELK — so all three are
// pinned to keep the diagrams as they were. It also narrowed flowchart label
// wrapping from 200px to 120px and added a 120px minimum node width; both are
// set back to mermaid 11's behaviour.
const baseConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  look: "classic",
  layout: "dagre",
  htmlLabels: false,
  flowchart: { useMaxWidth: false, htmlLabels: false, wrappingWidth: 200, minNodeWidth: 0 },
  sequence: { useMaxWidth: false },
  er: { useMaxWidth: false },
  class: { useMaxWidth: false, htmlLabels: false },
};

let loading: Promise<MermaidApi> | undefined;
function loadMermaid(): Promise<MermaidApi> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = mermaidUrl;
    script.onload = () => resolve((globalThis as unknown as { mermaid: MermaidApi }).mermaid);
    script.onerror = () => reject(new Error(`failed to load ${mermaidUrl}`));
    document.head.appendChild(script);
  });
  return loading;
}

// mermaid.initialize is global state, so renders are serialized: each one
// re-initializes with the current theme and then renders.
let queue: Promise<unknown> = Promise.resolve();
let renders = 0;

async function render() {
  const mermaid = await loadMermaid();
  const dark = document.documentElement.classList.contains("dark");
  const job = queue.then(async () => {
    mermaid.initialize({ ...baseConfig, theme: dark ? "dark" : "default" });
    // A fresh element id per render: mermaid removes any existing element
    // with the id it is given, which would yank the SVG Vue is showing.
    renders += 1;
    return mermaid.render(`${props.id}-${renders}`, decodeURIComponent(props.graph));
  });
  queue = job.catch(() => undefined);
  svg.value = (await job).svg;
}

let observer: MutationObserver | undefined;
onMounted(() => {
  let dark = document.documentElement.classList.contains("dark");
  observer = new MutationObserver(() => {
    const now = document.documentElement.classList.contains("dark");
    if (now !== dark) {
      dark = now;
      void render();
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  void render();
});
onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div class="mermaid" v-html="svg"></div>
</template>
