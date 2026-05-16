import type { BaseIssue } from "valibot";

/**
 * Strip caller-supplied values from Valibot issues before echoing them back
 * in a 4xx response. Valibot puts the offending field's value AND the entire
 * parent object on every `path` step; without this, a 1MB request body that
 * fails schema validation would reflect ~1MB of caller content back through
 * the error response.
 *
 * The schema-meaningful fields (`kind`, `type`, `expected`, `received`,
 * `message`, plus the path's structural breadcrumbs `type`/`origin`/`key`)
 * survive so a client can still pin-point which field failed.
 */
export function sanitizeIssues(issues: readonly BaseIssue<unknown>[]) {
	return issues.map((issue) => ({
		kind: issue.kind,
		type: issue.type,
		expected: issue.expected,
		received: issue.received,
		message: issue.message,
		path: issue.path?.map((step) => ({
			type: step.type,
			origin: step.origin,
			key: step.key,
		})),
	}));
}
