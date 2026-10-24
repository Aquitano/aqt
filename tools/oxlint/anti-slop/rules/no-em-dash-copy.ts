import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

export const noEmDashCopyRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description: "Disallow em dashes in string literals, template text, and JSX text.",
		},
		messages: {
			emDash: "Use a period or comma instead of an em dash in copy.",
		},
	},
	createOnce(context) {
		const check = (node: ESTree.Node, value: string | null | undefined) => {
			if (value?.includes("\u2014")) context.report({ node, messageId: "emDash" });
		};

		return {
			Literal(node) {
				if (typeof node.value === "string") check(node, node.value);
			},
			TemplateElement(node) {
				check(node, node.value.cooked);
			},
			JSXText(node) {
				check(node, node.value);
			},
		};
	},
});
