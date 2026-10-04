import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function DraftRecovery({
  newer,
  pending,
  onReload,
  onReapply,
  onDiscard,
  children,
}: {
  newer: boolean;
  pending: boolean;
  onReload: () => void;
  onReapply: () => void;
  onDiscard: () => void;
  children: ReactNode;
}) {
  return (
    <Alert>
      <AlertTitle>The saved version changed</AlertTitle>
      <AlertDescription>
        <p>Your draft is preserved. Review the current values before saving it again.</p>
        {newer ? (
          <details className="w-full">
            <summary className="cursor-pointer">Review current saved values</summary>
            <div className="mt-3 flex flex-col gap-3">
              {children}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={pending} onClick={onReapply}>
                  Reapply draft to current revision
                </Button>
                <Button type="button" variant="outline" disabled={pending} onClick={onDiscard}>
                  Discard draft and use current values
                </Button>
              </div>
            </div>
          </details>
        ) : (
          <Button type="button" variant="outline" disabled={pending} onClick={onReload}>
            Load current values for review
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
