import { ThemeProvider } from "@aqt/ui/components/theme-provider";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.tsx";

const container = document.getElementById("root");
if (container === null) throw new Error("index.html is missing the #root element");

createRoot(container).render(
  <StrictMode>
    <ThemeProvider forcedTheme="dark">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
