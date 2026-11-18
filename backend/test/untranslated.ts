// Finds text a person would read in a .tsx/.ts file that does not go through tr() or trn(): JSX text, and string or
// template literals with words in them, outside the places that never show text (class, style, keys, URLs, storage
// keys, comparisons, property names). A table of labels translated where it is shown lists its labels in the test's
// LISTED, and those are let through here. What it reports is file:line and the text.
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

const QUIET_ATTRS = new Set(['class', 'style', 'key', 'href', 'type', 'value', 'id', 'role', 'src', 'rel', 'target', 'autoComplete', 'inputMode', 'pattern', 'lang', 'name', 'for', 'loading', 'accept', 'capture', 'd', 'viewBox', 'fill', 'stroke']);
const QUIET_CALLS = /(\.(startsWith|includes|replace|split|join|getItem|setItem|removeItem|get|set|has|test|match|endsWith|find|indexOf|querySelector|getElementById|addEventListener|postMessage|log|warn|error)|^(fetch|call|req|matchMedia|window\.matchMedia|encodeURIComponent|useState|signal|Promise\.\w+|new URL))$/;

const words = (t: string) => /[A-Za-z]{2,}/.test(t);

export function untranslated(file: string, root: string, allowed: Set<string>): string[] {
  const text = readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const report = (n: ts.Node, t: string) => found.push(`${relative(root, file)}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${t.replace(/\s+/g, ' ').trim()}`);
  const quiet = (n: ts.Node): boolean => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && /^trn?$/.test(p.expression.getText())) return true;
      if (ts.isCallExpression(p) && QUIET_CALLS.test(p.expression.getText())) return true;
      if (ts.isJsxAttribute(p) && QUIET_ATTRS.has(p.name.getText())) return true;
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isTypeNode(p) || ts.isCaseClause(p) || ts.isElementAccessExpression(p)) return true;
      if (ts.isBinaryExpression(p) && /^(===|!==|==|!=|in)$/.test(p.operatorToken.getText())) return true;
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && /(headers|\.authorization|className|\.style\.|\.lang$|\.type$|\.src$|\.href$)/.test(p.left.getText())) return true;
      if (ts.isPropertyAssignment(p) && /^(method|headers|authorization|accept|credentials|mode|cache|behavior|block|position|display|border|background|color|font|margin|padding)/.test(p.name.getText())) return true;
    }
    return false;
  };
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const t = n.text.trim();
      if (words(t) && !allowed.has(t)) report(n, t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const t = n.text;
      if (/[A-Za-z]{3,}[ .:?!,]/.test(t) && !allowed.has(t) && !/^(#|\/|https?:|[a-z-]+:|data:)|var\(--|url\(|\dpx|[\w-]+\.(com|org|js|png|json|svg)\b/.test(t) && !quiet(n)) report(n, t);
    } else if (ts.isTemplateExpression(n)) {
      const parts = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' ');
      if (/[A-Za-z]{3,}/.test(parts) && !/^(#|\/|https?:|[a-z-]+:)/.test(n.head.text) && !/var\(--|url\(|\dpx/.test(parts) && !quiet(n)) report(n, n.getText());
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return found;
}
