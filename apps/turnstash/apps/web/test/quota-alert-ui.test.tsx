import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vite-plus/test";

import { QuotaAlerts } from "../src/components/QuotaAlerts";
import { QuotaAlertProvider } from "../src/quota-alert-context";

test("disabled alerts mount without a query or router client", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  expect(
    renderToStaticMarkup(
      <QuotaAlertProvider>
        <QuotaAlerts />
      </QuotaAlertProvider>,
    ),
  ).toBe("");
  vi.unstubAllGlobals();
});
