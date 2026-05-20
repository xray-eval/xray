import type { LinkProps } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/client/lib/utils.ts";

type BackLinkProps = LinkProps & { children: ReactNode; className?: string };

export function BackLink(props: BackLinkProps) {
	const { children, className, ...linkProps } = props;
	return (
		<Link
			{...linkProps}
			className={cn(
				"group inline-flex items-center gap-2 rounded-sm text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
				className,
			)}
		>
			<ArrowLeft
				aria-hidden="true"
				className="size-4 transition-transform group-hover:-translate-x-0.5"
			/>
			<span className="underline-offset-4 group-hover:underline">{children}</span>
		</Link>
	);
}
