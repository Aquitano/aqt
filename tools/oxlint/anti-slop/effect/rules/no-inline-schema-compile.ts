import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

const compilerMethods = new Set([
	"is",
	"decodeEffect",
	"decodeExit",
	"decodeOption",
	"decodePromise",
	"decodeResult",
	"decodeSync",
	"decodeUnknownEffect",
	"decodeUnknownExit",
	"decodeUnknownOption",
	"decodeUnknownPromise",
	"decodeUnknownResult",
	"decodeUnknownSync",
	"encodeEffect",
	"encodeExit",
	"encodeOption",
	"encodePromise",
	"encodeResult",
	"encodeSync",
	"encodeUnknownEffect",
	"encodeUnknownExit",
	"encodeUnknownOption",
	"encodeUnknownPromise",
	"encodeUnknownResult",
	"encodeUnknownSync",
]);

export const noInlineSchemaCompileRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Hoist immediately applied Effect schema compilers when their arguments do not depend on function-local bindings.",
		},
		messages: {
			inline: "Hoist {{method}}(...) to module scope and reuse the compiled function.",
		},
	},
	create(context) {
		const isSchemaImport = (identifier: ESTree.IdentifierReference) => {
			let scope = context.sourceCode.getScope(identifier);
			while (scope) {
				const variable = scope.set.get(identifier.name);
				if (variable) {
					return variable.defs.some((definition) => {
						if (
							definition.type !== "ImportBinding" ||
							definition.parent?.type !== "ImportDeclaration"
						) {
							return false;
						}
						if (definition.parent.source.value === "effect/Schema") {
							return definition.node.type === "ImportNamespaceSpecifier";
						}
						return (
							definition.parent.source.value === "effect" &&
							definition.node.type === "ImportSpecifier" &&
							(definition.node.imported.type === "Identifier"
								? definition.node.imported.name
								: definition.node.imported.value) === "Schema"
						);
					});
				}
				if (!scope.upper) return false;
				scope = scope.upper;
			}
			return false;
		};

		const canHoist = (compiler: ESTree.CallExpression) => {
			let scope = context.sourceCode.getScope(compiler);
			let insideFunction = false;
			while (scope.type !== "module" && scope.type !== "global") {
				if (scope.type === "function") insideFunction = true;
				for (const variable of scope.variables) {
					if (
						variable.references.some(
							({ identifier }) =>
								identifier.start >= compiler.start && identifier.end <= compiler.end,
						)
					)
						return false;
				}
				if (!scope.upper) return false;
				scope = scope.upper;
			}
			return insideFunction;
		};

		return {
			CallExpression(node) {
				const compiler = node.callee;
				if (compiler.type !== "CallExpression") return;
				const { callee } = compiler;
				if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return;
				const method =
					!callee.computed && callee.property.type === "Identifier"
						? callee.property.name
						: callee.property.type === "Literal" && typeof callee.property.value === "string"
							? callee.property.value
							: undefined;
				if (!method || !compilerMethods.has(method) || !isSchemaImport(callee.object)) return;
				const [schema] = compiler.arguments;
				if (!schema || !["Identifier", "MemberExpression", "CallExpression"].includes(schema.type))
					return;
				if (!canHoist(compiler)) return;
				context.report({
					node: compiler,
					messageId: "inline",
					data: { method: `${callee.object.name}.${method}` },
				});
			},
		};
	},
});
