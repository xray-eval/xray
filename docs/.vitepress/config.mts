import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// Site config for the public docs at https://xray-eval.github.io/xray/.
// Built by `pnpm docs:build`, deployed by .github/workflows/docs.yml on release.
// `withMermaid` registers client-side mermaid rendering for the ```mermaid fences
// (no headless browser at build time); GitHub renders the same fences natively.
export default withMermaid(
  defineConfig({
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
    // Mermaid: render at natural (readable) size instead of shrinking to fit the
    // prose column — wide diagrams scroll inside their panel (see style.css). The
    // plugin still auto-switches to mermaid's dark theme with the site. Defaults
    // here replace the plugin's, so keep securityLevel/startOnLoad explicit.
    mermaid: {
      securityLevel: "loose",
      startOnLoad: false,
      // Render labels as native SVG <text>, not HTML <foreignObject>. The HTML
      // labels measure their width against .vp-doc's font, so cloning the SVG into
      // the fullscreen viewer (a different CSS context) reflowed and clipped them.
      // SVG text bakes geometry into the SVG, so the clone renders identically.
      htmlLabels: false,
      flowchart: { useMaxWidth: false, htmlLabels: false },
      sequence: { useMaxWidth: false },
      er: { useMaxWidth: false },
      class: { useMaxWidth: false, htmlLabels: false },
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
  }),
);
