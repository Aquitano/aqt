import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

const suppressionDirective =
	/^\s*\*?\s*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck)|@effect-diagnostics)/u;
const typescriptDirective = /^\s*\*?\s*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/su;
const emptyComment = /^[\s*]*$/u;

export const requireSuppressionReasonRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description: "Require an explanation for lint disables and TypeScript suppressions.",
		},
		messages: {
			lint: "Explain this disable with `-- reason` or a comment on the line above.",
			typescript: "Explain this suppression after the directive or in a comment on the line above.",
		},
	},
	create(context) {
		const { sourceCode } = context;
		return {
			Program() {
				const comments = sourceCode.getAllComments();
				const commentsByEndLine = new Map<number, ESTree.Comment>();
				for (const comment of comments) {
					const { line, column } = comment.loc.start;
					if (!(sourceCode.lines[line - 1] ?? "").slice(0, column).trim()) {
						commentsByEndLine.set(comment.loc.end.line, comment);
					}
				}

				const explainedAbove = (comment: ESTree.Comment) => {
					let previous = commentsByEndLine.get(comment.loc.start.line - 1);
					while (
						previous &&
						(suppressionDirective.test(previous.value) || emptyComment.test(previous.value))
					) {
						previous = commentsByEndLine.get(previous.loc.start.line - 1);
					}
					return previous !== undefined;
				};

				for (const directive of sourceCode.getDisableDirectives().directives) {
					if (
						directive.type === "enable" ||
						directive.justification?.trim() ||
						explainedAbove(directive.node)
					)
						continue;
					context.report({ loc: directive.node.loc, messageId: "lint" });
				}

				for (const comment of comments) {
					const reason = typescriptDirective.exec(comment.value)?.[1];
					if (
						reason === undefined ||
						reason.replace(/^[\s:-]+/u, "").trim() ||
						explainedAbove(comment)
					)
						continue;
					context.report({ loc: comment.loc, messageId: "typescript" });
				}
			},
		};
	},
});
