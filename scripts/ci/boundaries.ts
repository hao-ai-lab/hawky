import ts from "typescript";
import { Glob } from "bun";
import { dirname, resolve, relative } from "node:path";

// Guard the narrow layers we can enforce today. This is not a claim that the
// legacy runtime is fully layered; expand rules as other dependencies are removed.
const errors: string[] = [];
for (const file of new Glob("src/live/**/*.ts").scanSync(".")) {
  const source = ts.createSourceFile(file, await Bun.file(file).text(), ts.ScriptTarget.Latest, true);
  function inspect(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text);
    ts.forEachChild(node, inspect);
  }
  function check(spec: string) {
    const target = spec.startsWith(".") ? relative(process.cwd(), resolve(dirname(file), spec)) : spec.replace(/^@\//, "src/");
    if (/^src\/(gateway|storage)\//.test(target)) errors.push(`${file} imports ${spec}: live providers must receive dependencies, not load gateway/state`);
  }
  inspect(source);
}
if (errors.length) throw new Error(errors.join("\n"));
console.log("Live layer has no gateway or storage imports.");
