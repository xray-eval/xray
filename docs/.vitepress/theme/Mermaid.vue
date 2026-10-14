<script setup lang="ts">
import { useData } from "vitepress";
import { onMounted, ref, watch } from "vue";

import { mermaidConfig } from "./mermaid-config";

// Client-only: the SSR pass emits an empty container, and the diagram renders
// after mount. `mermaid` is imported dynamically so it never lands in the SSR
// bundle or on pages without a diagram.
const props = defineProps<{ id: string; graph: string }>();
const { isDark } = useData();
const svg = ref("");

async function render() {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ ...mermaidConfig, theme: isDark.value ? "dark" : "default" });
  const result = await mermaid.render(props.id, decodeURIComponent(props.graph));
  svg.value = result.svg;
}

onMounted(render);
watch(isDark, render);
</script>

<template>
  <div class="mermaid" v-html="svg" />
</template>
