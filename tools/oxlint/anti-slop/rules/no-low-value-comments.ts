import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

const typescriptFile = /\.[cm]?tsx?$/u;
const directive =
	/^(?:(?:oxlint|eslint)-|@ts-|@effect-diagnostics|prettier-ignore|biome-ignore|c8 |istanbul |#(?:end)?region|SAFETY:)/u;
const divider = /^(?:[-=*#~_/+]{3,}.*|.*[-=*#~_]{3,})$/u;
const testStep = /^(?:arrange|act|assert|given|when|then)\s*[:.]?$/iu;
const jsdocType = /^@(?:param|returns?|type|typedef)\s+\{/u;
const emptyJsdocTag = /^@(?:param(?:\s+\[?[\w$.]+\]?)?|returns?)$/u;
const commentedCode =
	/^(?:(?:(?:const|let|var)\s+[\w${}[\], ]+=.*|import\s.+\sfrom\s+["'].+["']|(?:await\s+|return\s+)?[\w$.]+\(.*\)|[\w$.[\]]+\s*=\s*.+);|(?:if|for|while|switch)\s*\(.*\)\s*\{|\}(?:\s*else\s*\{)?)$/u;
const declaration =
	/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:static\s+)?(?:readonly\s+)?(?:(?:const|let|var|function\*?|class|interface|type|enum)\s+)?([A-Za-z_$][\w$]*)\s*[?!]?\s*[:=(<{]/u;
const fillerWords = new Set(
	"a an the of for to in on at by with from and or is are be this that it its as get set return create new current value given whether".split(
		" ",
	),
);

type CommentGroup = {
	first: ESTree.Comment;
	last: ESTree.Comment;
	lines: string[];
};

const words = (text: string) =>
	(text.toLowerCase().match(/[a-z0-9]+/gu) ?? [])
		.filter((word) => !fillerWords.has(word))
		.map((word) => (word.length > 3 ? word.replace(/([^s])s$/u, "$1") : word))
		.filter((word) => !fillerWords.has(word));

export const noLowValueCommentsRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Reject divider comments, test step labels, commented-out code, redundant JSDoc, and comments that repeat a declaration name.",
		},
	},
	create(context) {
		const { sourceCode } = context;
		const isTypeScript = typescriptFile.test(context.filename);

		const restatesName = (group: CommentGroup) => {
			if (group.lines.some((line) => line.startsWith("@"))) return false;
			const name = declaration.exec(sourceCode.lines[group.last.loc.end.line] ?? "")?.[1];
			if (!name) return false;
			const content = words(group.lines.join(" "));
			if (!content.length || content.length > 6) return false;
			const nameWords = new Set(
				words(
					name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2"),
				),
			);
			return content.every((word) => nameWords.has(word));
		};

		const problem = (group: CommentGroup) => {
			const { lines } = group;
			if (!lines.length || lines.some((line) => directive.test(line))) return undefined;
			if (lines.some((line) => divider.test(line)))
				return "Remove the section divider; let the code's structure show the grouping.";
			if (group.first.type === "Line" && lines.length === 1 && testStep.test(lines[0] ?? ""))
				return "Remove the test step label.";
			if (isTypeScript && lines.some((line) => jsdocType.test(line)))
				return "Remove the JSDoc type; TypeScript already expresses it.";
			if (lines.some((line) => emptyJsdocTag.test(line)))
				return "Remove the JSDoc tag that has no description.";
			if (group.first.type === "Line" && lines.every((line) => commentedCode.test(line)))
				return "Remove commented-out code; git keeps its history.";
			if (restatesName(group))
				return "This comment repeats the declaration name. Explain a constraint or remove it.";
			return undefined;
		};

		return {
			Program() {
				const groups: CommentGroup[] = [];
				for (const comment of sourceCode.getAllComments()) {
					const lines = comment.value
						.split("\n")
						.map((line) => line.replace(/^\s*\*?\s?/u, "").trim())
						.filter(Boolean);
					const previous = groups.at(-1);
					if (
						previous &&
						comment.type === "Line" &&
						previous.last.type === "Line" &&
						previous.last.loc.end.line === comment.loc.start.line - 1 &&
						previous.last.loc.start.column === comment.loc.start.column
					) {
						previous.last = comment;
						previous.lines.push(...lines);
					} else {
						groups.push({ first: comment, last: comment, lines });
					}
				}
				for (const group of groups) {
					const message = problem(group);
					if (message)
						context.report({
							loc: { start: group.first.loc.start, end: group.last.loc.end },
							message,
						});
				}
			},
		};
	},
});
