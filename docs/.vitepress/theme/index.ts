// Custom VitePress theme — palette + fonts mirror the application, and a custom
// Layout adds a fullscreen zoom/pan viewer for mermaid diagrams (Layout.vue).
// Reuses the app's own variable fonts (bundled, no external font request).
import DefaultTheme from "vitepress/theme";

import Layout from "./Layout.vue";

import "@fontsource-variable/onest";
import "@fontsource-variable/jetbrains-mono";
import "./style.css";

export default {
  extends: DefaultTheme,
  Layout,
};
