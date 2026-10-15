import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree, Reference, SourceCode } from "vite-plus/lint/plugins";

type Parameter = ESTree.ParamPattern;
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

const inspectingCallees = new Set(["Array.isArray", "JSON.stringify", "String"]);

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

function parameterIdentifier(parameter: Parameter): ESTree.BindingIdentifier | null {
  if (parameter.type === "TSParameterProperty") {
    return parameterIdentifier(parameter.parameter);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterIdentifier(parameter.left);
  }
  if (parameter.type === "RestElement") {
    return parameterIdentifier(parameter.argument);
  }
  return parameter.type === "Identifier" ? parameter : null;
}

function returnsTypePredicate(node: ParameterOwner): boolean {
  return node.returnType?.typeAnnotation.type === "TSTypePredicate";
}

/** A reference that opens the value up: the surrounding code is the boundary, not a pass-through. */
function inspectsValue(sourceCode: SourceCode, reference: Reference): boolean {
  const identifier = reference.identifier;
  const parent = identifier.parent;
  if (parent.type === "UnaryExpression") return parent.operator === "typeof";
  if (parent.type === "BinaryExpression") {
    return (
      (parent.operator === "instanceof" && parent.left === identifier) ||
      (parent.operator === "in" && parent.right === identifier)
    );
  }
  return (
    parent.type === "CallExpression" &&
    parent.arguments.some((argument) => argument === identifier) &&
    inspectingCallees.has(sourceCode.getText(parent.callee))
  );
}

/** Disallow unknown inputs except where the function itself narrows or serialises the value. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters unless the function is the boundary that inspects them: a type predicate, a typeof/instanceof/in check, Array.isArray, JSON.stringify or String. `cause` is always allowed.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      if (returnsTypePredicate(node)) return;
      const declared = context.sourceCode.getDeclaredVariables(node);
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation?.typeAnnotation.type !== "TSUnknownKeyword") continue;
        const identifier = parameterIdentifier(parameter);
        const name =
          identifier?.name ??
          context.sourceCode.getText(parameter).replace(/\s*:\s*unknown\s*$/u, "");
        if (name === "cause") continue;
        const variable = declared.find((candidate) =>
          candidate.identifiers.some((candidateIdentifier) => candidateIdentifier === identifier),
        );
        if (
          variable?.references.some((reference) => inspectsValue(context.sourceCode, reference))
        ) {
          continue;
        }
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
