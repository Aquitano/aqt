import { Alert, AlertAction, AlertDescription, AlertTitle } from "@aqt/ui/components/alert";
import { Button } from "@aqt/ui/components/button";
import { Spinner } from "@aqt/ui/components/spinner";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { CircleAlertIcon, KeyRoundIcon, LogInIcon } from "lucide-react";
import type { ReactNode } from "react";

import { failureMessage, isUnauthorized } from "../api";
import { dashboardSessionQuery } from "../queries";

export const RequestFailure = ({ error }: { readonly error: Error }) => {
  const session = useQuery(dashboardSessionQuery());
  if (isUnauthorized(error) && session.data?.mode === "oidc")
    return (
      <Alert>
        <LogInIcon />
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
      <KeyRoundIcon />
      <AlertTitle>This archive needs a token</AlertTitle>
      <AlertDescription>
        Paste the admin token or a read token into the field in the header, then press Enter.
      </AlertDescription>
    </Alert>
  ) : (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>Request failed</AlertTitle>
      <AlertDescription>{failureMessage(error)}</AlertDescription>
    </Alert>
  );
};

export const Pending = () => (
  <div className="flex items-center justify-center py-16">
    <Spinner className="size-6 text-muted-foreground" />
  </div>
);

export const Async = <T,>({
  query,
  children,
}: {
  readonly query: UseQueryResult<T>;
  readonly children: (data: T) => ReactNode;
}) => {
  if (query.isPending) return <Pending />;
  if (query.isError) return <RequestFailure error={query.error} />;
  return <>{children(query.data)}</>;
};
