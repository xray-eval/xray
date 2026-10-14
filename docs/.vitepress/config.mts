import { defineConfig } from "vitepress";

// Site config for the public docs at https://xray-eval.github.io/xray/.
// Built by `pnpm docs:build`, deployed by .github/workflows/docs.yml on release.
export default defineConfig({
  title: "xray",
  description:
    "Open-source, self-hosted replay/eval framework for LiveKit voice agents",
  base: "/xray/", // GitHub Pages project site
  cleanUrls: true,
  lastUpdated: true,
  appearance: "dark", // dark-first (matches the app palette); the light toggle still works
  // localhost URLs (the quickstart's "open http://localhost:8080") are
  // intentionally unreachable at build time; everything else stays checked.
  ignoreDeadLinks: [/^https?:\/\/localhost(:\d+)?/],
  markdown: {
    // ```mermaid fences become <Mermaid>, rendered client-side by
    // theme/Mermaid.vue (no headless browser at build time); GitHub renders
    // the same fences natively. The source is URI-encoded so it survives
    // being an HTML attribute.
    config(md) {
      const fence = md.renderer.rules.fence;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        if (token.info.trim() !== "mermaid") {
          return fence ? fence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
        }
        return `<Mermaid id="mermaid-${idx}" graph="${encodeURIComponent(token.content)}" />`;
      };
    },
  },
  themeConfig: {
    search: { provider: "local" }, // built-in MiniSearch — no native binary, no external service
    // Reading order runs from "use it" to "understand it": Architecture (the
    // deep mental model) sits last, after the practical guides.
    nav: [
      { text: "Quick start", link: "/quickstart" },
      { text: "Integrate", link: "/integrate" },
      { text: "Python SDK", link: "/sdk-python" },
      { text: "Wire contract", link: "/wire-contract" },
      { text: "Architecture", link: "/architecture" },
    ],
    sidebar: [
      {
        text: "Documentation",
        items: [
          { text: "Overview", link: "/" },
          { text: "Quick start", link: "/quickstart" },
          { text: "Integrate", link: "/integrate" },
          { text: "Python SDK", link: "/sdk-python" },
          { text: "Wire contract", link: "/wire-contract" },
          { text: "Architecture", link: "/architecture" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/xray-eval/xray" },
    ],
    editLink: {
      pattern: "https://github.com/xray-eval/xray/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});
