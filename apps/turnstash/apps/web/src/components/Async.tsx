import { Alert, AlertAction, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Button } from "@aqt/ui/components/button";
import { Spinner } from "@aqt/ui/components/spinner";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { CircleAlertIcon, KeyRoundIcon, LogInIcon } from "lucide-react";
import type { ReactNode } from "react";

import { failureMessage, isUnauthorized } from "../api";
import { dashboardSessionQuery } from "../queries";

export const RequestFailure = ({
  error,
  onRetry,
  retrying = false,
  stale = false,
}: {
  readonly error: Error;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  readonly stale?: boolean;
}) => {
  const session = useQuery(dashboardSessionQuery());
  if (isUnauthorized(error) && session.data?.mode === "oidc")
    return (
      <Alert>
        <LogInIcon aria-hidden="true" />
        <AlertTitle>Your session has expired</AlertTitle>
        <AlertDescription>Sign in again to keep reading your archive.</AlertDescription>
        <AlertAction>
          <Button size="sm" nativeButton={false} render={<a href="/auth/login" />}>
            Sign in with authentik
          </Button>
        </AlertAction>
      </Alert>
    );
  return isUnauthorized(error) ? (
    <Alert variant="destructive">
      <KeyRoundIcon aria-hidden="true" />
      <AlertTitle>This archive needs a token</AlertTitle>
      <AlertDescription>
        Paste the admin token or a read token into the field in the header, then press Enter.
      </AlertDescription>
    </Alert>
  ) : (
    <Alert variant={stale ? "warning" : "destructive"}>
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{stale ? "Could not refresh" : "Request failed"}</AlertTitle>
      <AlertDescription>
        {stale && "Showing the last loaded data. "}
        {failureMessage(error)}
      </AlertDescription>
      {onRetry !== undefined && (
        <AlertAction>
          <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
};

export const Pending = () => (
  <div
    role="status"
    className="flex animate-in items-center justify-center gap-2 py-16 text-sm text-muted-foreground duration-300 fade-in-0 fill-mode-backwards [animation-delay:150ms] motion-reduce:animate-none"
  >
    <Spinner aria-hidden="true" className="size-5 motion-reduce:animate-none" />
    <span>Loading…</span>
  </div>
);

export const Async = <T,>({
  query,
  children,
}: {
  readonly query: UseQueryResult<T>;
  readonly children: (data: T) => ReactNode;
}) => {
  const retry = () => {
    void query.refetch();
  };
  if (query.data === undefined)
    return query.isError ? (
      <RequestFailure error={query.error} onRetry={retry} retrying={query.isFetching} />
    ) : (
      <Pending />
    );
  if (query.isError && isUnauthorized(query.error))
    return <RequestFailure error={query.error} onRetry={retry} retrying={query.isFetching} />;
  return (
    <>
      {query.isError && (
        <RequestFailure error={query.error} onRetry={retry} retrying={query.isFetching} stale />
      )}
      {children(query.data)}
    </>
  );
};
