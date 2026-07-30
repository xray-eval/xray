import { cn } from "@/client/lib/utils.ts";

/** A labelled segmented control over a closed set of string modes. */
export function ModeToggle<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: readonly { value: T; label: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<fieldset className="flex items-center gap-2 border-0 p-0">
			{/* The legend names the group for assistive tech; the visible span is the
			    styled copy of the same word, so it's hidden from the a11y tree. */}
			<legend className="sr-only">{label}</legend>
			<span
				aria-hidden
				className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
			>
				{label}
			</span>
			<div className="flex rounded-md border border-border/60 p-0.5">
				{options.map((option) => (
					<button
						key={option.value}
						type="button"
						aria-pressed={option.value === value}
						onClick={() => onChange(option.value)}
						className={cn(
							"rounded px-2.5 py-1 text-xs transition-colors",
							"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
							option.value === value
								? "bg-muted font-medium text-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{option.label}
					</button>
				))}
			</div>
		</fieldset>
	);
}
