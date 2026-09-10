import { z } from "zod";

import type { McpToolMeta, Meta } from "../api/index";
import { appRouter } from "../api/routers/index";

export type GalleryTool = McpToolMeta & {
	/** Dotted procedure path on a tRPC caller, e.g. "artworks.update". */
	path: string;
	inputSchema: z.ZodObject;
};

/** tRPC 11 flattens every procedure into `_def.procedures` keyed by its dotted
 * path, but still types that record as the nested router shape. */
type FlatProcedure = { _def: { meta?: Meta; inputs: readonly unknown[] } };

function inputSchemaOf(path: string, inputs: readonly unknown[]): z.ZodObject {
	if (inputs.length === 0) {
		return z.object({});
	}
	if (inputs.length > 1) {
		throw new Error(`MCP tool ${path} has more than one input parser`);
	}
	const [input] = inputs;
	const schema = input instanceof z.ZodOptional ? input.unwrap() : input;
	if (!(schema instanceof z.ZodObject)) {
		throw new Error(`MCP tool ${path} needs an object input schema`);
	}
	return schema;
}

/** Every procedure carrying `mcp` meta, as a ready-to-register tool. The zod
 * input of the procedure is the tool's input schema, so the two can't drift. */
function buildGalleryTools(): GalleryTool[] {
	const procedures = appRouter._def.procedures as unknown as Record<
		string,
		FlatProcedure
	>;
	const tools: GalleryTool[] = [];
	const names = new Set<string>();

	for (const [path, procedure] of Object.entries(procedures)) {
		const mcp = procedure._def.meta?.mcp;
		if (!mcp) continue;
		// A personal access token authenticates the MCP endpoint and nothing
		// else, so token management must stay off the agent surface — otherwise
		// a leaked token could mint itself more.
		if (path.startsWith("apiTokens.")) {
			throw new Error(`${path} must not be exposed as an MCP tool`);
		}
		if (names.has(mcp.name)) {
			throw new Error(`Duplicate MCP tool name: ${mcp.name}`);
		}
		names.add(mcp.name);
		tools.push({
			...mcp,
			path,
			inputSchema: inputSchemaOf(path, procedure._def.inputs),
		});
	}

	return tools;
}

export const galleryTools = buildGalleryTools();
