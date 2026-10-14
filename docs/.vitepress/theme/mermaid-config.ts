import type { MermaidConfig } from "mermaid";

// Render at natural (readable) size instead of shrinking to fit the prose
// column — wide diagrams scroll inside their panel (see style.css). The theme
// is not set here: Mermaid.vue picks "dark" or "default" from the site's
// appearance on every render.
export const mermaidConfig: MermaidConfig = {
  securityLevel: "loose",
  startOnLoad: false,
  // mermaid 12 switched the default to ELK layout + the "neo" look and cut
  // flowchart `wrappingWidth` from 200 to 120, which squeezes these diagrams'
  // long route/path labels into narrow boxes broken mid-word
  // ("/v1/conversation s/:hash"). dagre + classic + 200 keep the wide,
  // readable rendering the diagrams were laid out for.
  layout: "dagre",
  look: "classic",
  // Render labels as native SVG <text>, not HTML <foreignObject>. The HTML
  // labels measure their width against .vp-doc's font, so cloning the SVG into
  // the fullscreen viewer (a different CSS context) reflowed and clipped them.
  // SVG text bakes geometry into the SVG, so the clone renders identically.
  htmlLabels: false,
  flowchart: { useMaxWidth: false, htmlLabels: false, wrappingWidth: 200 },
  sequence: { useMaxWidth: false },
  er: { useMaxWidth: false },
  class: { useMaxWidth: false, htmlLabels: false },
};
