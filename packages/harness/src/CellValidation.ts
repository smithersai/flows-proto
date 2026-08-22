/**
 * Cell validation at the boundary.
 *
 * A cell used to be parsed for the first time inside the realm that runs it, so
 * "this does not compile" arrived as a settled frame: one whole model turn
 * bought, spent, and answered with a syntax error. The r90 wave paid for nine
 * of them — `sympy__sympy-20154` emitted a 53 KB program that never ran and
 * then had it replayed back to it verbatim as input, `django__django-15987`
 * spent 59 % of the instance's whole bill on one dead cell, and
 * `sympy__sympy-18763` emitted the *same* syntax error twice in a row because
 * the first failure was invisible to it.
 *
 * Parsing is cheap and the controller can do it before it commits anything, so
 * it does: this module is the parse, and `CellTurn` answers what it finds
 * inside the same frame, at cached-prefix price, instead of ending the frame on
 * it.
 *
 * It also reports what parsing gives away for free — statements the cell wrote
 * after its own first top-level `return`, which never run. That is a notice and
 * not a rejection: the program is legal, the model simply did not know.
 *
 * Nothing here executes anything, and nothing here is a gate. The only outcomes
 * are a rejection the model is asked to fix in this frame, or a sentence added
 * to the next one.
 *
 * @since 0.1.0
 */
import ts from "typescript"
import * as Cell from "./Cell.ts"

/**
 * What the boundary learned by parsing one cell.
 *
 * Exactly one of `rejected` and `compiled` is present: a cell either has a
 * program to run or a reason it does not. `notice` is independent of both —
 * legal source can still carry a statement that will never run.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Validation {
  /** Why the cell cannot run, when it cannot. */
  readonly rejected: Cell.Rejected | undefined
  /** The JavaScript to evaluate, when there is any. */
  readonly compiled: string | undefined
  /** Something true about the cell that does not stop it running. */
  readonly notice: string | undefined
}

/**
 * The module syntax a cell used, named as the model would say it.
 *
 * @private
 */
type ModuleSyntax = "import" | "export" | "require"

/**
 * Finds module syntax a cell wrote, by parsing rather than by matching text.
 *
 * A cell has no module loader to reach, so this is a real violation. Its
 * strings are another matter: cells routinely pass a `bash` command whose
 * Python heredoc reads `from pathlib import Path`, or a `grep` pattern naming
 * `from _pytest import`. That text is data. A regexp over the source cannot
 * tell the two apart, and reading the source as text rejected five otherwise
 * correct SWE-bench frames in one wave, one of them an instance's opening
 * frame, each costing a whole turn to a rule the cell had not broken.
 *
 * A namespace body is not descended into. `export` inside one is not ESM, and
 * the namespace itself is refused by {@link nonErasableSyntax}.
 *
 * @private
 */
const moduleSyntax = (source: ts.SourceFile): ModuleSyntax | undefined => {
  let found: ModuleSyntax | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) found = "import"
    else if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) found = "export"
    else if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    ) found = "export"
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found = "import"
    else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) found = "import"
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      found = "require"
    } else if (!ts.isModuleDeclaration(node)) ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const nonErasableSyntax = (source: ts.SourceFile): string | undefined => {
  let found: string | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isEnumDeclaration(node)) found = "enum declarations"
    else if (ts.isModuleDeclaration(node)) found = "namespace/module declarations"
    else if (
      ts.isParameter(node) &&
      node.modifiers?.some((modifier) =>
          modifier.kind === ts.SyntaxKind.PublicKeyword ||
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === ts.SyntaxKind.ReadonlyKeyword ||
          modifier.kind === ts.SyntaxKind.OverrideKeyword
        ) === true
    ) found = "parameter properties"
    else ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * The first thing a compiler refused, as a sentence naming where it is.
 *
 * The line and the offending text are the whole point. A model handed
 * "'}' expected." can only guess; handed "line 34: `if (a) {`" it edits the
 * line it wrote.
 *
 * @private
 */
const located = (text: string, diagnostic: ts.Diagnostic): string => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
  /* v8 ignore next -- `transpileModule` attaches its synthetic source file and a position to every syntactic diagnostic it reports, and syntactic diagnostics are the only kind it reports; the guard discharges the optional types on `ts.Diagnostic`, which also covers program-wide diagnostics that have neither */
  if (diagnostic.file === undefined || diagnostic.start === undefined) return message
  const at = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  // A compiler points past the last token when the thing that is missing is a
  // closing one, so the named line is regularly blank. Quoting a blank line
  // says nothing and reads like a truncation, so it is left out.
  /* v8 ignore next -- the position came from the same text, so the line it names is a line this split produced; the coalesce discharges the optional type an index read carries */
  const line = (text.split("\n")[at.line] ?? "").trim()
  return `line ${at.line + 1}, column ${at.character + 1}: ${message}${line === "" ? "" : `\n  ${line}`}`
}

const firstError = (diagnostics: ReadonlyArray<ts.Diagnostic> | undefined): ts.Diagnostic | undefined =>
  diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error)

/**
 * Names the statements a cell wrote after its own first top-level `return`.
 *
 * Blocks in one reply are concatenated into one program and the first `return`
 * ends it, which the contract states — but a model that batches four steps into
 * four blocks has written three programs that will not run, and nothing else
 * would ever tell it so. Parsing already produced the statement list, so this
 * costs nothing and can only be right: a top-level `return` is unconditional by
 * construction.
 *
 * @private
 */
const unreachable = (source: ts.SourceFile, text: string): string | undefined => {
  const index = source.statements.findIndex((statement) => ts.isReturnStatement(statement))
  if (index < 0 || index === source.statements.length - 1) return undefined
  const at = source.getLineAndCharacterOfPosition(source.statements[index]!.getStart(source))
  const dead = source.statements.length - index - 1
  const last = source.getLineAndCharacterOfPosition(source.statements[source.statements.length - 1]!.getStart(source))
  return `Dead code — the top-level \`return\` on line ${
    at.line + 1
  } ends the frame, so the ${dead} top-level statement${dead === 1 ? "" : "s"} after it (through line ${
    last.line + 1
  } of ${
    text.split("\n").length
  }) never ran. Blocks in one reply are one program: put the work before the return, or return once at the end.`
}

/**
 * Parses one cell and reports everything the parse can decide.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const validate = (cell: Cell.Source): Validation => {
  const isTypeScript = cell.language === "typescript"
  const parsed = ts.createSourceFile(
    isTypeScript ? "cell.ts" : "cell.js",
    cell.text,
    ts.ScriptTarget.ES2022,
    true,
    isTypeScript ? ts.ScriptKind.TS : ts.ScriptKind.JS
  )
  const refuse = (rejected: Cell.Rejected): Validation => ({ rejected, compiled: undefined, notice: undefined })
  const moduleUse = moduleSyntax(parsed)
  if (moduleUse !== undefined) {
    return refuse(
      new Cell.Rejected({
        code: "imports_forbidden",
        message: `A cell may not ${moduleUse} anything: it runs in a realm with no module loader. ` +
          "Use ctx.call for every effect and ctx.flows for the catalog it may call; they are the only bindings a cell has."
      })
    )
  }
  if (isTypeScript) {
    const forbidden = nonErasableSyntax(parsed)
    if (forbidden !== undefined) {
      return refuse(
        new Cell.Rejected({
          code: "compile_failed",
          message: `The TypeScript cell uses ${forbidden}, which are not erasable syntax.`
        })
      )
    }
  }
  // Both languages are compiled, and only the TypeScript output is kept. The
  // JavaScript pass exists for its diagnostics: a cell that does not parse is
  // the single most expensive thing a frame can contain, and until this ran at
  // the boundary the only party that ever noticed was the realm — after the
  // model turn had been bought.
  const transpiled = ts.transpileModule(cell.text, {
    compilerOptions: isTypeScript
      ? {
        erasableSyntaxOnly: true,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      }
      : { allowJs: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: isTypeScript ? "cell.ts" : "cell.js",
    reportDiagnostics: true
  })
  const diagnostic = firstError(transpiled.diagnostics)
  if (diagnostic !== undefined) {
    return refuse(
      new Cell.Rejected({
        code: "compile_failed",
        message: `The cell did not compile — ${located(cell.text, diagnostic)}`
      })
    )
  }
  return {
    rejected: undefined,
    // The JavaScript a cell wrote is run as written. Only TypeScript is handed
    // to the emitter, and only to have its type-only syntax erased.
    compiled: isTypeScript ? transpiled.outputText : cell.text,
    notice: unreachable(parsed, cell.text)
  }
}
