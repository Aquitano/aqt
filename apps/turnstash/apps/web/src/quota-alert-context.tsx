import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  dismissedKey,
  preferencesKey,
  readPreferences,
  readReceipts,
  rememberAlert,
  savePreferences,
} from "./quota-alert-storage";
import type { QuotaAlert, QuotaAlertPreferences } from "./quota-alerts";

const useSettings = () => {
  const [preferences, setPreferences] = useState(readPreferences);
  const [dismissed, setDismissed] = useState(() => readReceipts(dismissedKey, Date.now()));
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === preferencesKey || event.key === null) setPreferences(readPreferences());
      if (event.key === dismissedKey || event.key === null)
        setDismissed(readReceipts(dismissedKey, Date.now()));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const choose = useCallback(
    (patch: Partial<QuotaAlertPreferences>) => {
      const next = { ...preferences, ...patch };
      savePreferences(next);
      setPreferences(next);
      setDeliveryError(null);
    },
    [preferences],
  );
  const dismiss = useCallback((alert: QuotaAlert) => {
    setDismissed(rememberAlert(dismissedKey, alert, Date.now()));
  }, []);
  return useMemo(
    () => ({ preferences, choose, dismissed, dismiss, deliveryError, setDeliveryError }),
    [preferences, choose, dismissed, dismiss, deliveryError],
  );
};

const QuotaAlertContext = createContext<ReturnType<typeof useSettings> | null>(null);

export const QuotaAlertProvider = ({ children }: { readonly children: ReactNode }) => {
  const settings = useSettings();
  return <QuotaAlertContext value={settings}>{children}</QuotaAlertContext>;
};

export const useQuotaAlertSettings = () => {
  const settings = useContext(QuotaAlertContext);
  if (settings === null)
    throw new Error("useQuotaAlertSettings was called outside QuotaAlertProvider");
  return settings;
};
