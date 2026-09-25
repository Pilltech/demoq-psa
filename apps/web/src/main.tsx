import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Fonts are bundled, not loaded from a CDN: Khmer must render offline and on locked-down networks.
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/kantumruy-pro/khmer-400.css";
import "@fontsource/kantumruy-pro/khmer-600.css";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 5_000 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
