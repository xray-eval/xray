import type { ReactElement } from "react";
import type { defaultStyles } from "react-json-view-lite";
import { JsonView } from "react-json-view-lite";

import { isJsonContainer, safeParseJson } from "@/client/lib/json.ts";

/**
 * Style props for `react-json-view-lite`. Built entirely with our Tailwind
 * tokens so we don't have to import the library's bundled CSS (the package
 * ships hashed class names that would collide with our design system).
 */
// react-json-view-lite@2.5.0 imports StyleProps internally but doesn't
// re-export it; recover the type from the typed `defaultStyles` export.
const JSON_VIEW_STYLE: typeof defaultStyles = {
	container: "font-mono text-[11px] leading-relaxed text-foreground/90",
	basicChildStyle: "ml-3",
	label: "mr-1.5 text-sky-400",
	clickableLabel: "mr-1.5 cursor-pointer text-sky-400",
	nullValue: "text-destructive",
	undefinedValue: "text-destructive",
	numberValue: "text-orange-400",
	stringValue: "text-emerald-400",
	booleanValue: "text-orange-400",
	otherValue: "text-foreground",
	punctuation: "mr-1 text-muted-foreground/60",
	expandIcon: "mr-1 inline-block w-3 select-none text-muted-foreground before:content-['▸']",
	collapseIcon: "mr-1 inline-block w-3 select-none text-muted-foreground before:content-['▾']",
	collapsedContent: "mx-1 text-muted-foreground/60 before:content-['…']",
	childFieldsContainer: "ml-1 border-l border-border/30 pl-2",
	ariaLables: { collapseJson: "Collapse", expandJson: "Expand" },
	stringifyStringValues: false,
};

/** Syntax-styled JSON tree. `expandLevel` nodes are open on first render. */
export function JsonTree({
	data,
	expandLevel = 1,
}: {
	data: object;
	expandLevel?: number | undefined;
}) {
	return (
		<JsonView
			data={data}
			style={JSON_VIEW_STYLE}
			shouldExpandNode={(level) => level < expandLevel}
		/>
	);
}

/**
 * A JSON tree when `raw` parses to an object or array, else `null` so each
 * caller supplies its own non-JSON fallback. The one place the string→JSON
 * detection lives — `JsonOrText` and the span attribute renderer share it.
 */
export function jsonTreeOrNull(raw: string, expandLevel?: number): ReactElement | null {
	const parsed = safeParseJson(raw);
	if (parsed.ok && isJsonContainer(parsed.value)) {
		return <JsonTree data={parsed.value} expandLevel={expandLevel} />;
	}
	return null;
}

/**
 * Render an opaque JSON string: a pretty tree when it parses to an object or
 * array, the raw text otherwise. Tool args/results and span attribute values
 * arrive as strings that may or may not be JSON.
 */
export function JsonOrText({ raw, expandLevel }: { raw: string; expandLevel?: number }) {
	return (
		jsonTreeOrNull(raw, expandLevel) ?? <span className="break-all text-foreground/80">{raw}</span>
	);
}
