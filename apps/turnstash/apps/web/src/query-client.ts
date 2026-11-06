import { QueryCache, QueryClient } from "@tanstack/react-query";

import { isUnauthorized } from "./api";

export const createQueryClient = () =>
  new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (isUnauthorized(error)) query.setState({ data: undefined, dataUpdatedAt: 0 });
      },
    }),
    defaultOptions: { queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false } },
  });
