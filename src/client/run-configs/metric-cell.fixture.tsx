import { MetricCell } from "./metric-cell.tsx";

export default {
	measured: (
		<MetricCell cell={{ value: 812, display: "812ms", detail: "p50 780ms · p95 1.2s", n: 24 }} />
	),
	best: (
		<MetricCell
			cell={{ value: 640, display: "640ms", detail: "p50 610ms · p95 890ms", n: 24 }}
			best
		/>
	),
	unmeasured: <MetricCell cell={{ value: null, display: "—", detail: null, n: 0 }} />,
	"thin sample": <MetricCell cell={{ value: 2100, display: "2.1s", detail: "p50 2.1s", n: 1 }} />,
};
