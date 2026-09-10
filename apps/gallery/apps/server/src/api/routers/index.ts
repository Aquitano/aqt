import { protectedProcedure, publicProcedure, router } from "../index";
import { apiTokensRouter } from "./api-tokens";
import { artistsRouter } from "./artists";
import { artworksRouter } from "./artworks";
import { exhibitionsRouter } from "./exhibitions";
import { journalRouter } from "./journal";
import { tagsRouter } from "./tags";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  privateData: protectedProcedure.query(({ ctx }) => {
    return {
      message: "This is private",
      user: ctx.session.user,
    };
  }),
  artworks: artworksRouter,
  artists: artistsRouter,
  exhibitions: exhibitionsRouter,
  journal: journalRouter,
  tags: tagsRouter,
  apiTokens: apiTokensRouter,
});
export type AppRouter = typeof appRouter;
