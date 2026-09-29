import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LinkPage } from "./pages/LinkPage";
// Fonts are bundled, not loaded from a CDN: Khmer must render offline and on locked-down networks.
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/kantumruy-pro/khmer-400.css";
import "@fontsource/kantumruy-pro/khmer-600.css";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 5_000 } },
});

// The public influencer page (INF-LK-06) needs no session and never calls a staff API: it is rendered on its own,
// without the app shell (which asks /api/v1/auth/me).
const linkMatch = /^\/l\/([^/]+)\/?$/.exec(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {linkMatch ? (
      <LinkPage token={decodeURIComponent(linkMatch[1]!)} />
    ) : (
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    )}
  </StrictMode>,
);
