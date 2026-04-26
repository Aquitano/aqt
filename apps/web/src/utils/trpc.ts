import type { AppRouter } from "@aqt-gallery/api/routers/index";
import { createTRPCContext } from "@trpc/tanstack-react-query";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();
