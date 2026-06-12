import { protectedProcedure, publicProcedure, router } from "../index";
import { artworksRouter } from "./artworks";
import { galleriesRouter } from "./galleries";
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
	galleries: galleriesRouter,
	tags: tagsRouter,
});
export type AppRouter = typeof appRouter;
