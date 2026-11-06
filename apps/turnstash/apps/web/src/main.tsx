import { ThemeProvider } from "@aqt/ui/components/theme-provider";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./app.css";
import { createQueryClient } from "./query-client";
import { router } from "./router";

const queryClient = createQueryClient();

const container = document.getElementById("root");
if (container === null) throw new Error("index.html is missing the #root element");

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
