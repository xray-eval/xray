import type { LinkProps } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Fragment } from "react";

import { cn } from "@/client/lib/utils.ts";

type BreadcrumbCrumb =
	| ({ readonly label: string; readonly current?: false; readonly className?: string } & LinkProps)
	| { readonly label: string; readonly current: true };

export function Breadcrumbs({ crumbs }: { crumbs: readonly BreadcrumbCrumb[] }) {
	const seen = new Map<string, number>();
	const keyed = crumbs.map((crumb) => {
		const n = seen.get(crumb.label) ?? 0;
		seen.set(crumb.label, n + 1);
		return { crumb, key: n === 0 ? crumb.label : `${crumb.label}#${n}` };
	});
	return (
		<nav aria-label="Breadcrumb">
			<ol className="flex flex-wrap items-center gap-2 text-sm">
				{keyed.map(({ crumb, key }, i) => (
					<Fragment key={key}>
						{i > 0 && (
							<li aria-hidden="true" className="text-muted-foreground/50">
								<ChevronRight className="size-3" strokeWidth={2.5} />
							</li>
						)}
						<li>
							{crumb.current ? (
								<span aria-current="page" className="text-foreground">
									{crumb.label}
								</span>
							) : (
								<BreadcrumbLink crumb={crumb} />
							)}
						</li>
					</Fragment>
				))}
			</ol>
		</nav>
	);
}

function BreadcrumbLink({ crumb }: { crumb: BreadcrumbCrumb & { current?: false } }) {
	const { label, current: _current, className, ...linkProps } = crumb;
	return (
		<Link
			{...linkProps}
			className={cn(
				"rounded-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
				className,
			)}
		>
			{label}
		</Link>
	);
}
