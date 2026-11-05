import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { QuotaAlerts } from "../src/components/QuotaAlerts";
import { QuotaAlertProvider, useQuotaAlertSettings } from "../src/quota/context";
import { preferencesKey } from "../src/quota/storage";

afterEach(() => vi.unstubAllGlobals());

test("disabled alerts mount without a query or router client", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  expect(
    renderToStaticMarkup(
      <QuotaAlertProvider>
        <QuotaAlerts />
      </QuotaAlertProvider>,
    ),
  ).toBe("");
});

const CaptureChoose = ({
  capture,
}: {
  readonly capture: (choose: ReturnType<typeof useQuotaAlertSettings>["choose"]) => void;
}) => {
  capture(useQuotaAlertSettings().choose);
  return null;
};

test("granting notification permission preserves settings changed while permission was pending", async () => {
  const stored = new Map([
    [preferencesKey, JSON.stringify({ low: true, unused: false, desktop: false })],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  const captured: { choose?: ReturnType<typeof useQuotaAlertSettings>["choose"] } = {};
  renderToStaticMarkup(
    <QuotaAlertProvider>
      <CaptureChoose
        capture={(choose) => {
          captured.choose = choose;
        }}
      />
    </QuotaAlertProvider>,
  );
  const choose = captured.choose;
  if (choose === undefined) throw new Error("Quota preferences callback was not captured");
  const permissionGranted = Promise.resolve().then(() => choose({ desktop: true }));
  choose({ unused: true });
  await permissionGranted;
  expect(JSON.parse(stored.get(preferencesKey) ?? "null")).toEqual({
    low: true,
    unused: true,
    desktop: true,
  });
});
