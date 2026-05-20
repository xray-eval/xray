import type { MouseEvent, ReactNode } from "react";

import { Checkbox } from "@/client/components/ui/checkbox.tsx";
import { TableCell, TableRow } from "@/client/components/ui/table.tsx";

export function ClickableRow({
	selected,
	onToggle,
	onOpen,
	selectLabel,
	children,
}: {
	selected: boolean;
	onToggle: () => void;
	onOpen: () => void;
	selectLabel: string;
	children: ReactNode;
}) {
	return (
		<TableRow
			data-state={selected ? "selected" : undefined}
			onClick={onOpen}
			className="cursor-pointer border-border/60 transition-colors hover:bg-muted/40"
		>
			<TableCell className="px-4 py-3" onClick={stopRowNavigation}>
				<Checkbox
					checked={selected}
					onCheckedChange={onToggle}
					onClick={stopRowNavigation}
					aria-label={selectLabel}
				/>
			</TableCell>
			{children}
		</TableRow>
	);
}

export function stopRowNavigation(e: MouseEvent<HTMLElement>) {
	e.stopPropagation();
}
