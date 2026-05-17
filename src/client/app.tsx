import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";

import { createQueryClient } from "./api/query-client.ts";
import { createAppRouter } from "./router/router.ts";

export function App() {
	// `useState` (not `useMemo`) so the QueryClient and Router survive
	// StrictMode's double-invocation in dev. See tkdodo.eu/blog/the-useless-use-callback.
	const [queryClient] = useState(createQueryClient);
	const [router] = useState(() => createAppRouter());

	return (
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
}
