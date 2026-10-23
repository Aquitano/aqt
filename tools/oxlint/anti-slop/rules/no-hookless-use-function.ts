import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

const hookName = /^use[A-Z]/u;
const hookCall = /^use(?:[A-Z]|$)/u;

export const noHooklessUseFunctionRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow functions named useX that call no hooks.",
		},
		messages: {
			hookless:
				'"{{name}}" calls no hooks. Rename it to a plain function or call its hook dependency inside it.',
		},
	},
	createOnce(context) {
		const functions: Array<{ node: FunctionNode; callsHook: boolean }> = [];

		const enterFunction = (node: FunctionNode) => {
			functions.push({ node, callsHook: false });
		};

		const exitFunction = () => {
			const current = functions.pop();
			if (!current || current.callsHook) return;
			const { node } = current;
			const name =
				node.type === "FunctionDeclaration"
					? node.id
					: node.parent.type === "VariableDeclarator" && node.parent.id.type === "Identifier"
						? node.parent.id
						: undefined;
			if (!name || !hookName.test(name.name)) return;
			context.report({ node: name, messageId: "hookless", data: { name: name.name } });
		};

		return {
			before() {
				functions.length = 0;
			},
			FunctionDeclaration: enterFunction,
			"FunctionDeclaration:exit": exitFunction,
			FunctionExpression: enterFunction,
			"FunctionExpression:exit": exitFunction,
			ArrowFunctionExpression: enterFunction,
			"ArrowFunctionExpression:exit": exitFunction,
			CallExpression(node) {
				const { callee } = node;
				const name =
					callee.type === "Identifier"
						? callee.name
						: callee.type === "MemberExpression" &&
							  !callee.computed &&
							  callee.property.type === "Identifier"
							? callee.property.name
							: undefined;
				const current = functions.at(-1);
				if (current && name && hookCall.test(name)) current.callsHook = true;
			},
		};
	},
});
