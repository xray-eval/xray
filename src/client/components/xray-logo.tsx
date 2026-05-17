// Group rotation is 45° so the four blades point N/E/S/W, not NE/SE/SW/NW.
const BLADE =
	"M 0,0 C 20,-25 60,-70 100,-100 C 70,-60 35,-25 25,-5 C 35,5 50,15 70,30 C 40,20 15,10 0,0 Z";

type XrayLogoProps = {
	className?: string;
	"aria-hidden"?: boolean;
};

export function XrayLogo({ className, "aria-hidden": ariaHidden }: XrayLogoProps) {
	return (
		<svg
			viewBox="0 0 400 400"
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			stroke="currentColor"
			strokeWidth={20}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			role={ariaHidden ? undefined : "img"}
			aria-hidden={ariaHidden}
		>
			<title>xray</title>
			<g transform="translate(200 200) rotate(45)">
				<path d={BLADE} />
				<path d={BLADE} transform="rotate(90)" />
				<path d={BLADE} transform="rotate(180)" />
				<path d={BLADE} transform="rotate(270)" />
			</g>
		</svg>
	);
}
