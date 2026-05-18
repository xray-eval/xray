import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import { MissingRootElementError } from "./main.errors.ts";

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new MissingRootElementError();
}

createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
