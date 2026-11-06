import { Alert, AlertAction, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Button } from "@aqt/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BellIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { currentLimitsQuery } from "../queries";
import { useQuotaAlertSettings } from "../quota-alert-context";
import { receiptMatchesAlert } from "../quota-alert-storage";
import { quotaAlertsOf } from "../quota-alerts";
import { notifyQuotaAlerts } from "../quota-notifications";

const ActiveQuotaAlerts = () => {
  const { preferences, dismissed, dismiss, deliveryError, setDeliveryError } =
    useQuotaAlertSettings();
  const [nowMs, setNowMs] = useState(Date.now);
  const report = useQuery({
    ...currentLimitsQuery(),
    refetchIntervalInBackground: preferences.desktop,
  });
  const navigate = useNavigate();
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const timer = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);
  const alerts = useMemo(
    () =>
      report.isSuccess
        ? quotaAlertsOf(report.data, preferences, nowMs).filter(
            (alert) =>
              !dismissed.some(
                (receipt) => receiptMatchesAlert(receipt, alert) && receipt.until > nowMs,
              ),
          )
        : [],
    [report.isSuccess, report.data, preferences, nowMs, dismissed],
  );
  useEffect(() => {
    if (!preferences.desktop || deliveryError !== null) return undefined;
    let current = true;
    void notifyQuotaAlerts(
      alerts,
      () => current,
      (alert) => {
        void navigate({
          to: "/limits",
          search: { provider: alert.provider, windows: { [alert.provider]: alert.windowMinutes } },
        });
      },
    ).then((error) => {
      if (current && error !== null) setDeliveryError(error);
      return undefined;
    });
    return () => {
      current = false;
    };
  }, [alerts, preferences.desktop, deliveryError, navigate, setDeliveryError]);
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className={
        alerts.length > 0 || report.isError ? "flex flex-col gap-2 px-4 pt-4 sm:px-8" : undefined
      }
    >
      {report.isError && (
        <Alert variant="warning">
          <BellIcon aria-hidden="true" />
          <AlertTitle>Quota monitoring is unavailable</AlertTitle>
          <AlertDescription>
            Warnings will resume when Turnstash can read your current limits.
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              disabled={report.isFetching}
              onClick={() => void report.refetch()}
            >
              {report.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {alerts.map((alert) => (
        <Alert key={alert.id} role="group" variant={alert.kind === "low" ? "warning" : "default"}>
          <BellIcon aria-hidden="true" />
          <AlertTitle>{alert.title}</AlertTitle>
          <AlertDescription>
            <p>{alert.description}</p>
            <Link
              to="/limits"
              search={{
                provider: alert.provider,
                windows: { [alert.provider]: alert.windowMinutes },
              }}
            >
              View limits
            </Link>
          </AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Dismiss ${alert.title}`}
              onClick={() => void dismiss(alert)}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </AlertAction>
        </Alert>
      ))}
    </div>
  );
};

export const QuotaAlerts = () => {
  const { preferences } = useQuotaAlertSettings();
  return preferences.low || preferences.unused ? <ActiveQuotaAlerts /> : null;
};
