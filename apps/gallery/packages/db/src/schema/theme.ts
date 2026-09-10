import { z } from "zod";

/**
 * Single source of truth for the 3D gallery/museum theme shape.
 *
 * The db column type (`jsonb("theme").$type<Theme>()`), the tRPC mutation
 * input, and — through tRPC type inference — the web editor and renderer all
 * derive from this one schema. Add a field here and it flows everywhere.
 *
 * Every field is optional; concrete fallback values live with the renderer
 * (`apps/web/.../museum/theme.ts`), since defaults are a presentation concern.
 */
export const themeSchema = z.object({
	wallColor: z.string().optional(),
	accentWallColor: z.string().optional(),
	floorColor: z.string().optional(),
	floorRoughness: z.number().min(0).max(1).optional(),
	ambientIntensity: z.number().min(0).max(5).optional(),
	lightTemperature: z.enum(["warm", "neutral", "cool"]).optional(),
});

export type Theme = z.infer<typeof themeSchema>;
