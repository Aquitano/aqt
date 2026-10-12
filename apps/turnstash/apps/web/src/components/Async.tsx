import { Banner, LinkButton, Loader } from "@cloudflare/kumo";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { failureMessage, isUnauthorized } from "../api";
import { dashboardSessionQuery } from "../queries";

export const RequestFailure = ({ error }: { readonly error: Error }) => {
  const session = useQuery(dashboardSessionQuery());
  if (isUnauthorized(error) && session.data?.mode === "oidc")
    return (
      <Banner
        variant="alert"
        title="Your session has expired"
        description="Sign in again to keep reading your archive."
        action={
          <LinkButton href="/auth/login" size="sm" variant="primary">
            Sign in with authentik
          </LinkButton>
        }
      />
    );
  return isUnauthorized(error) ? (
    <Banner
      variant="error"
      title="This archive needs a token"
      description="Paste the admin token or a read token into the field in the header, then press Enter."
    />
  ) : (
    <Banner variant="error" title="Request failed" description={failureMessage(error)} />
  );
};

export const Pending = () => (
  <div className="center">
    <Loader size="lg" />
  </div>
);

export const Async = <T,>({
  query,
  children,
}: {
  readonly query: UseQueryResult<T, Error>;
  readonly children: (data: T) => ReactNode;
}) => {
  if (query.isPending) return <Pending />;
  if (query.isError) return <RequestFailure error={query.error} />;
  return <>{children(query.data)}</>;
};
