import { Button } from "@aqt/ui/components/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@aqt/ui/components/field";
import { Switch } from "@aqt/ui/components/switch";
import { useState } from "react";

import { Section } from "../components/Section";
import { useQuotaAlertSettings } from "../quota/context";
import { desktopNotificationsAvailable } from "../quota/notifications";

export const QuotaAlertSettings = () => {
  const { preferences, choose, deliveryError } = useQuotaAlertSettings();
  const [requesting, setRequesting] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const available = desktopNotificationsAvailable();
  const denied = available && Notification.permission === "denied";
  const enableDesktop = async () => {
    setRequesting(true);
    setPermissionError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") choose({ desktop: true });
      else
        setPermissionError(
          permission === "denied"
            ? "Notifications are blocked. Change this site's notification permission in your browser settings to enable them."
            : "Permission was not granted. In-app alerts are still available.",
        );
    } catch {
      setPermissionError(
        "This browser cannot enable desktop notifications. In-app alerts are still available.",
      );
    } finally {
      setRequesting(false);
    }
  };
  return (
    <Section title="Quota alerts">
      <div className="flex flex-col gap-6 pt-1.5">
        <p className="text-xs text-muted-foreground">
          Optional alerts while Turnstash is open. Saved in this browser. Readings must be less than
          30 minutes old; forecasts use the last hour's pace.
        </p>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="quota-low">Running low</FieldLabel>
              <FieldDescription>
                Warn at 10% remaining, or when quota may run out within an hour before reset.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="quota-low"
              checked={preferences.low}
              onCheckedChange={(low) => choose({ low })}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="quota-unused">Expiring unused</FieldLabel>
              <FieldDescription>
                Warn when at least 20% may expire unused at a reset within the next hour.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="quota-unused"
              checked={preferences.unused}
              onCheckedChange={(unused) => choose({ unused })}
            />
          </Field>
        </FieldGroup>
        <div className="flex flex-col items-start gap-2 border-t pt-4">
          <h3 className="text-sm font-medium">Desktop notifications</h3>
          <p className="text-xs text-muted-foreground">
            Also notify once per alert type and quota window. Turnstash must stay open; background
            tabs may be delayed by your browser.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={
              requesting ||
              (!preferences.desktop &&
                (!available || denied || (!preferences.low && !preferences.unused)))
            }
            onClick={() => (preferences.desktop ? choose({ desktop: false }) : enableDesktop())}
          >
            {requesting
              ? "Requesting permission…"
              : preferences.desktop
                ? "Disable desktop notifications"
                : "Enable desktop notifications"}
          </Button>
          <p role="status" className="text-xs text-muted-foreground">
            {permissionError ??
              deliveryError ??
              (!available
                ? "Desktop notifications are unavailable in this browser. In-app alerts still work."
                : denied
                  ? "Notifications are blocked in your browser's site settings."
                  : !preferences.low && !preferences.unused
                    ? "Enable an alert above to use desktop notifications."
                    : preferences.desktop
                      ? "Desktop notifications are enabled for this browser."
                      : "Your browser will ask for permission when you enable notifications.")}
          </p>
        </div>
        <div className="border-t pt-4">
          <h3 className="text-sm font-medium">OpenObserve and other OTLP backends</h3>
          <p className="mt-2 text-xs text-muted-foreground">
            For alerts with the dashboard closed, enable OTLP metrics on the Turnstash server and
            configure quota rules and notification destinations in OpenObserve. These browser
            switches do not control server metrics or OpenObserve alerts.
          </p>
        </div>
      </div>
    </Section>
  );
};
