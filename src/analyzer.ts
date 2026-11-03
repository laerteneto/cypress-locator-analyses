import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { clamp, Finding, Grade, gradeOf, RuleId, ScoreContext, ScoringOptions } from './rules';
import { scoreCss, scoreText, scoreXPath, ScoredSelector } from './selector';

export interface LocatorUse {
  /** Unique id: absolute file path + offset (+ custom command arguments, when reached through one). */
  id: string;
  file: string;
  line: number;
  column: number;
  /** Source snippet of the query chain (e.g. `cy.get('[data-cy=row]').eq(1)`). */
  code: string;
  /** Fragility score 0 (robust) .. 100 (very fragile). */
  score: number;
  grade: Grade;
  findings: Finding[];
  /** Ids of the locators this one is built on (aliases, page object getters, `.within()` subjects). */
  ancestors: string[];
}

export interface StaticTest {
  title: string;
  titlePath: string[];
  file: string;
  line: number;
  column: number;
  /** Locators the test depends on (its body, hooks, page objects, helpers and custom commands it calls). */
  uses: LocatorUse[];
}

export interface AnalyzeOptions extends ScoringOptions {
  /** Path to a tsconfig.json (path aliases, etc). Auto-detected from cwd if omitted. */
  tsconfig?: string;
  /** Names of the test function. Default: ['it', 'specify']. */
  testFunctionNames?: string[];
  /**
   * Files that register custom commands (Cypress.Commands.add). Their imports are followed too.
   * Default: every JS/TS file under `cypress/support` of the Cypress project that holds the specs.
   */
  supportFiles?: string[];
  cwd?: string;
}

/** Testing Library queries (@testing-library/cypress). */
const TESTING_LIBRARY_RE = /^find(?:All)?By(Role|TestId|LabelText|Text|PlaceholderText|AltText|Title|DisplayValue)$/;
const TESTING_LIBRARY_RULES: Record<string, RuleId> = {
  Role: 'role-unnamed', TestId: 'testid', LabelText: 'label', Text: 'text', PlaceholderText: 'placeholder',
  AltText: 'alt-text', Title: 'title', DisplayValue: 'text',
};
/** Commands that find elements on their own. */
const SOURCE_METHODS = new Set(['get', 'find', 'contains', 'xpath']);
/** Commands that narrow or move the current subject. */
const POSITION_METHODS = new Set(['eq', 'first', 'last']);
const TRAVERSAL_METHODS = new Set([
  'parent', 'parents', 'parentsUntil', 'closest', 'siblings', 'next', 'nextAll', 'nextUntil', 'prev', 'prevAll', 'prevUntil',
]);
const OTHER_QUERY_METHODS = new Set(['children', 'filter', 'not', 'shadow']);
/** Commands that yield the same subject, so a query chain continues through them. */
const PASS_THROUGH_METHODS = new Set([
  'click', 'dblclick', 'rightclick', 'type', 'clear', 'check', 'uncheck', 'select', 'selectFile', 'focus', 'blur',
  'trigger', 'scrollIntoView', 'scrollTo', 'should', 'and', 'as', 'submit', 'within',
]);
const CY_ROOT_QUERIES = new Set(['root']);
const IGNORE_MARKER = 'cypress-locator-analyses-ignore';
const MAX_DEPTH = 12;

type FnNode = ts.FunctionLikeDeclaration;

interface Scope {
  titles: string[];
  hooks: FnNode[];
  parent?: Scope;
}

interface CustomCommand {
  name: string;
  fn: FnNode;
  /** Registered with { prevSubject }: the first parameter is the subject it is chained on. */
  child: boolean;
  /** The command just returns a query (`(sel) => cy.get(...)`), so it is scored as part of the chain. */
  query: boolean;
}

interface PartScore {
  /** Score of what this part is anchored on (combined with max). */
  base?: number;
  /** Penalty added on top (combined with sum). */
  extra?: number;
  findings: Finding[];
}

export function analyzeFiles(files: string[], options: AnalyzeOptions = {}): StaticTest[] {
  const cwd = options.cwd ?? process.cwd();
  const specs = files.map((f) => path.resolve(cwd, f));
  const support = (options.supportFiles ?? detectSupportFiles(specs, cwd)).map((f) => path.resolve(cwd, f));
  const rootNames = [...new Set([...specs, ...support])];
  const program = ts.createProgram({ rootNames, options: compilerOptions(cwd, options.tsconfig) });
  const analyzer = new Analyzer(program, new ScoreContext(options), options.testFunctionNames ?? ['it', 'specify']);
  const tests: StaticTest[] = [];
  for (const file of specs) {
    const sf = program.getSourceFile(file);
    if (sf) tests.push(...analyzer.analyzeTestFile(sf));
  }
  return tests;
}

const CONFIG_FILES = ['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs', 'cypress.config.cjs', 'cypress.config.mts', 'cypress.config.cts'];

/** Finds the Cypress project of each spec (folder with cypress.config.*) and returns the files in its cypress/support. */
export function detectSupportFiles(specs: string[], cwd: string): string[] {
  const roots = new Set<string>();
  const dirs = [cwd, ...specs.map((s) => path.dirname(s))];
  for (const start of dirs) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (CONFIG_FILES.some((f) => fs.existsSync(path.join(dir, f)))) {
        roots.add(dir);
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(full);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
    }
  };
  for (const root of roots) walk(path.join(root, 'cypress', 'support'));
  return out.sort();
}

function compilerOptions(cwd: string, tsconfig?: string): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    allowJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    esModuleInterop: true,
    skipLibCheck: true,
  };
  const configPath = tsconfig ? path.resolve(cwd, tsconfig) : nearestConfigFile(cwd);
  if (configPath && fs.existsSync(configPath)) {
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => undefined,
    });
    if (parsed) return { ...defaults, ...parsed.options, allowJs: true, noEmit: true };
  }
  return { ...defaults, noEmit: true };
}

/** The closest tsconfig.json or jsconfig.json (JavaScript projects keep their import aliases there). */
function nearestConfigFile(cwd: string): string | undefined {
  const found = ['tsconfig.json', 'jsconfig.json']
    .map((name) => ts.findConfigFile(cwd, fs.existsSync, name))
    .filter((f): f is string => f !== undefined);
  return found.sort((a, b) => path.dirname(b).length - path.dirname(a).length)[0];
}

class Analyzer {
  private readonly checker: ts.TypeChecker;
  private readonly chainCache = new Map<ts.Node, LocatorUse | null>();
  private readonly declCache = new Map<ts.Node, LocatorUse | null>();
  private readonly fnCache = new Map<ts.Node, LocatorUse[]>();
  private readonly inProgress = new Set<ts.Node>();
  /** Parameters of the custom commands being followed, bound to the arguments of the call. */
  private readonly bindings = new Map<ts.Node, { expr: ts.Expression; suffix: string }>();
  /** Appended to locator ids while following a custom command, so each set of arguments is its own locator. */
  private idSuffix = '';
  private commandsCache?: Map<string, CustomCommand>;
  private aliasesCache?: Map<string, ts.Expression[]>;

  constructor(
    private readonly program: ts.Program,
    private readonly ctx: ScoreContext,
    private readonly testNames: string[],
  ) {
    this.checker = program.getTypeChecker();
  }

  // -------------------------------------------------------------------------
  // Test discovery
  // -------------------------------------------------------------------------

  analyzeTestFile(sf: ts.SourceFile): StaticTest[] {
    const tests: StaticTest[] = [];
    this.scanScope(sf, { titles: [], hooks: [] }, tests);
    return tests;
  }

  private scanScope(container: ts.Node, scope: Scope, tests: StaticTest[]): void {
    const pending: Array<() => void> = [];
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const kind = this.classifyCall(n);
        if (kind?.type === 'hook') {
          scope.hooks.push(kind.fn);
          return;
        }
        if (kind?.type === 'describe') {
          const child: Scope = { titles: kind.title ? [...scope.titles, kind.title] : scope.titles, hooks: [], parent: scope };
          pending.push(() => this.scanScope(kind.fn, child, tests));
          return;
        }
        if (kind?.type === 'test') {
          pending.push(() => tests.push(this.buildTest(n, kind.title, kind.fn, scope)));
          return;
        }
      }
      ts.forEachChild(n, walk);
    };
    // For describe callbacks walk the body only, so the callback itself is not re-classified.
    if (ts.isFunctionLike(container) && (container as FnNode).body) walk((container as FnNode).body!);
    else walk(container);
    // Hooks apply to every test of the scope regardless of declaration order, so build tests afterwards.
    pending.forEach((fn) => fn());
  }

  private classifyCall(call: ts.CallExpression):
    | { type: 'test'; title: string; fn: FnNode }
    | { type: 'describe'; title: string; fn: FnNode }
    | { type: 'hook'; fn: FnNode }
    | undefined {
    const name = dottedName(call.expression);
    if (!name) return undefined;
    const [head, ...rest] = name.split('.');
    const fn = [...call.arguments].reverse().find((a): a is ts.ArrowFunction | ts.FunctionExpression =>
      ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (!fn) return undefined;
    const title = call.arguments.length > 0 ? titleOf(call.arguments[0]) : undefined;
    const hookNames = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll', 'before', 'after']);
    const isTestName = (n: string) => this.testNames.includes(n) || (n.startsWith('x') && this.testNames.includes(n.slice(1)));

    if (isTestName(head)) {
      if (rest.length === 0 || (rest.length === 1 && ['only', 'skip'].includes(rest[0]))) {
        return title !== undefined ? { type: 'test', title, fn } : undefined;
      }
      if (rest[0] === 'describe') return { type: 'describe', title: title ?? '', fn };
      if (rest.length === 1 && hookNames.has(rest[0])) return { type: 'hook', fn };
      return undefined;
    }
    if (['describe', 'context', 'suite', 'xdescribe', 'xcontext'].includes(head)) return { type: 'describe', title: title ?? '', fn };
    if (rest.length === 0 && hookNames.has(head)) return { type: 'hook', fn };
    return undefined;
  }

  private buildTest(call: ts.CallExpression, title: string, fn: FnNode, scope: Scope): StaticTest {
    const sf = call.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(call.getStart());
    const found = new Map<string, LocatorUse>();
    this.collect(fn, found, 0);
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      for (const hook of s.hooks) this.collect(hook, found, 0);
    }
    // A locator that is only the base of a more specific one is already counted through it.
    const all = [...found.values()];
    const bases = new Set(all.flatMap((u) => u.ancestors));
    const uses = all.filter((u) => !bases.has(u.id)).sort((a, b) => b.score - a.score);
    return {
      title,
      titlePath: [...scope.titles, title],
      file: path.resolve(sf.fileName),
      line: line + 1,
      column: character + 1,
      uses,
    };
  }

  // -------------------------------------------------------------------------
  // Collecting locator uses reachable from a node
  // -------------------------------------------------------------------------

  private collect(root: ts.Node, out: Map<string, LocatorUse>, depth: number): void {
    const add = (u: LocatorUse | null | undefined) => {
      if (u) out.set(u.id, u);
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        if (this.isQueryCall(n)) {
          if (this.isOutermostQuery(n)) add(this.chainFrom(n));
        } else if (depth < MAX_DEPTH) {
          for (const u of this.followCall(n, depth + 1)) add(u);
        }
      } else if ((ts.isPropertyAccessExpression(n) || (ts.isIdentifier(n) && isValueReference(n))) && !isCallee(n)) {
        const decl = this.declarationOf(n);
        if (decl) add(this.locatorOfDeclaration(decl));
      }
      ts.forEachChild(n, visit);
    };
    visit(root);
  }

  /** Locator uses inside a function, method or custom command called from a test. */
  private followCall(call: ts.CallExpression, depth: number): LocatorUse[] {
    const fn = this.functionOf(call);
    if (fn?.body) {
      const cacheable = this.bindings.size === 0;
      const cached = cacheable ? this.fnCache.get(fn) : undefined;
      if (cached) return cached;
      if (this.inProgress.has(fn)) return [];
      this.inProgress.add(fn);
      const out = new Map<string, LocatorUse>();
      this.collect(fn.body, out, depth);
      this.inProgress.delete(fn);
      const list = [...out.values()];
      if (cacheable) this.fnCache.set(fn, list);
      return list;
    }
    const cmd = this.commandOf(call);
    if (!cmd?.fn.body || this.inProgress.has(cmd.fn)) return [];
    const out = new Map<string, LocatorUse>();
    this.withCommand(cmd, call, () => this.collect(cmd.fn.body!, out, depth));
    return [...out.values()];
  }

  private functionOf(call: ts.CallExpression): FnNode | undefined {
    let decl: ts.Node | undefined;
    try {
      decl = this.checker.getResolvedSignature(call)?.declaration;
    } catch {
      decl = undefined;
    }
    if (!decl || ts.isJSDocSignature(decl)) decl = this.declarationOf(call.expression);
    if (!decl || this.isExternal(decl)) return undefined;
    if (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertyAssignment(decl)) {
      const init = decl.initializer && unwrap(decl.initializer);
      decl = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
    }
    if (decl && ts.isFunctionLike(decl) && (decl as FnNode).body) return decl as FnNode;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Custom commands and aliases
  // -------------------------------------------------------------------------

  /** Custom commands registered with Cypress.Commands.add() anywhere in the program (support files, specs). */
  private commands(): Map<string, CustomCommand> {
    if (this.commandsCache) return this.commandsCache;
    const map = new Map<string, CustomCommand>();
    this.commandsCache = map;
    for (const sf of this.ownSourceFiles()) {
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && dottedName(n.expression) === 'Cypress.Commands.add' && n.arguments.length >= 2) {
          const name = ts.isStringLiteralLike(n.arguments[0]) ? n.arguments[0].text : undefined;
          const fn = this.functionExpression(n.arguments[n.arguments.length - 1]);
          const opts = n.arguments.length >= 3 ? unwrap(n.arguments[1]) : undefined;
          const child = opts !== undefined && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) =>
            ts.isPropertyAssignment(p) && p.name.getText() === 'prevSubject' && p.initializer.kind !== ts.SyntaxKind.FalseKeyword);
          if (name && fn) map.set(name, { name, fn, child, query: returnsOnly(fn) });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return map;
  }

  private commandOf(call: ts.CallExpression): CustomCommand | undefined {
    const name = methodName(call);
    return name !== undefined && this.isCypressChain(call.expression) ? this.commands().get(name) : undefined;
  }

  private functionExpression(e: ts.Expression): FnNode | undefined {
    const x = unwrap(e);
    if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return x;
    if (ts.isIdentifier(x)) {
      const decl = this.declarationOf(x);
      if (decl && ts.isFunctionDeclaration(decl)) return decl;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return this.functionExpression(decl.initializer);
    }
    return undefined;
  }

  /** Runs `fn` with the command's parameters bound to the call's arguments (and its subject, for child commands). */
  private withCommand<T>(cmd: CustomCommand, call: ts.CallExpression, fn: () => T): T {
    const params = [...cmd.fn.parameters];
    const args: ts.Expression[] = [...call.arguments];
    const key = args.map((a) => this.resolveString(a) ?? a.getText()).join(', ');
    const added: ts.Node[] = [];
    const previousSuffix = this.idSuffix;
    if (cmd.child && params.length > 0) {
      const subject = params.shift()!;
      this.bindings.set(subject, { expr: (call.expression as ts.PropertyAccessExpression).expression, suffix: previousSuffix });
      added.push(subject);
    }
    params.forEach((p, i) => {
      if (args[i]) {
        this.bindings.set(p, { expr: args[i], suffix: previousSuffix });
        added.push(p);
      }
    });
    this.idSuffix = `${previousSuffix}@${cmd.name}(${key})`;
    this.inProgress.add(cmd.fn);
    try {
      return fn();
    } finally {
      this.inProgress.delete(cmd.fn);
      this.idSuffix = previousSuffix;
      added.forEach((p) => this.bindings.delete(p));
    }
  }

  /** Arguments are expressions of the caller: their locators get the caller's ids. */
  private inCallerContext<T>(suffix: string, fn: () => T): T {
    const current = this.idSuffix;
    this.idSuffix = suffix;
    try {
      return fn();
    } finally {
      this.idSuffix = current;
    }
  }

  /** Receivers of every `.as('name')` call, by alias name. */
  private aliases(): Map<string, ts.Expression[]> {
    if (this.aliasesCache) return this.aliasesCache;
    const map = new Map<string, ts.Expression[]>();
    this.aliasesCache = map;
    for (const sf of this.ownSourceFiles()) {
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && methodName(n) === 'as' && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
          const name = n.arguments[0].text;
          map.set(name, [...(map.get(name) ?? []), (n.expression as ts.PropertyAccessExpression).expression]);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return map;
  }

  /** The locator saved under `@name`: the closest preceding `.as('name')` in the same file, else any. */
  private aliasLocator(name: string, from: ts.Node): LocatorUse | null {
    const candidates = this.aliases().get(name.replace(/\.all$/, '')) ?? [];
    const sf = from.getSourceFile();
    const sameFile = candidates.filter((c) => c.getSourceFile() === sf);
    const before = sameFile.filter((c) => c.getStart() < from.getStart());
    const ordered = [...before.reverse(), ...sameFile, ...candidates];
    for (const expr of ordered) {
      const use = this.locatorOfExpression(expr);
      if (use) return use;
    }
    return null;
  }

  private ownSourceFiles(): ts.SourceFile[] {
    return this.program.getSourceFiles().filter((sf) => !this.isExternal(sf));
  }

  // -------------------------------------------------------------------------
  // Resolving names to locators (variables, page object properties, getters)
  // -------------------------------------------------------------------------

  private declarationOf(expr: ts.Node): ts.Declaration | undefined {
    const target = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
    let sym = this.checker.getSymbolAtLocation(target);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = this.checker.getAliasedSymbol(sym);
      } catch {
        return undefined;
      }
    }
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!decl || this.isExternal(decl)) return undefined;
    return decl;
  }

  private locatorOfDeclaration(decl: ts.Node): LocatorUse | null {
    const bound = this.bindings.get(decl);
    if (bound) return this.inCallerContext(bound.suffix, () => this.locatorOfExpression(bound.expr));
    const cacheable = this.bindings.size === 0;
    if (cacheable && this.declCache.has(decl)) return this.declCache.get(decl)!;
    if (this.inProgress.has(decl)) return null;
    this.inProgress.add(decl);
    let result: LocatorUse | null = null;

    if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) && decl.initializer) {
      result = this.locatorOfExpression(decl.initializer);
    } else if (ts.isPropertyDeclaration(decl)) {
      const value = decl.initializer ?? this.constructorAssignment(decl);
      result = value ? this.locatorOfExpression(value) : null;
    } else if (ts.isGetAccessorDeclaration(decl)) {
      // Only getters are "values"; methods are handled when called.
      result = this.returnedLocator(decl);
    } else {
      // JS: this.button = cy.get(...)
      const value = assignedValue(decl);
      if (value) result = this.locatorOfExpression(value);
    }

    this.inProgress.delete(decl);
    if (cacheable) this.declCache.set(decl, result);
    return result;
  }

  /** `this.name = <expr>` inside the constructor of the property's class. */
  private constructorAssignment(prop: ts.PropertyDeclaration): ts.Expression | undefined {
    const cls = prop.parent;
    if (!ts.isClassLike(cls) || !prop.name || !ts.isIdentifier(prop.name)) return undefined;
    const name = prop.name.text;
    const ctor = cls.members.find(ts.isConstructorDeclaration);
    if (!ctor?.body) return undefined;
    let found: ts.Expression | undefined;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        n.left.name.text === name) {
        found = n.right;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(ctor.body);
    return found;
  }

  private returnedLocator(fn: FnNode): LocatorUse | null {
    if (!fn.body) return null;
    if (!ts.isBlock(fn.body)) return this.locatorOfExpression(fn.body);
    let result: LocatorUse | null = null;
    const visit = (n: ts.Node): void => {
      if (result || (ts.isFunctionLike(n) && n !== fn)) return;
      if (ts.isReturnStatement(n) && n.expression) result = this.locatorOfExpression(n.expression);
      else ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return result;
  }

  private locatorOfExpression(expression: ts.Expression): LocatorUse | null {
    const expr = unwrap(expression);
    if (ts.isCallExpression(expr)) {
      if (this.isQueryCall(expr)) return this.chainFrom(expr);
      const name = methodName(expr);
      if (name && PASS_THROUGH_METHODS.has(name)) return this.locatorOfExpression((expr.expression as ts.PropertyAccessExpression).expression);
      const fn = this.functionOf(expr);
      if (fn && !this.inProgress.has(fn)) {
        this.inProgress.add(fn);
        const r = this.returnedLocator(fn);
        this.inProgress.delete(fn);
        return r;
      }
      return null;
    }
    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
      const decl = this.declarationOf(expr);
      return decl ? this.locatorOfDeclaration(decl) : null;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Query chains
  // -------------------------------------------------------------------------

  private isQueryName(name: string, call: ts.CallExpression): boolean {
    if (SOURCE_METHODS.has(name) || POSITION_METHODS.has(name) || TRAVERSAL_METHODS.has(name) ||
      OTHER_QUERY_METHODS.has(name) || TESTING_LIBRARY_RE.test(name)) return true;
    return this.commandOf(call)?.query === true;
  }

  private isQueryCall(call: ts.CallExpression): boolean {
    const name = methodName(call);
    return name !== undefined && this.isQueryName(name, call);
  }

  /** `cy.get()` and custom parent queries start over from the root (or from the `.within()` subject). */
  private isResetCall(call: ts.CallExpression): boolean {
    const name = methodName(call);
    if (name === 'get') return true;
    const cmd = this.commandOf(call);
    return cmd !== undefined && cmd.query && !cmd.child;
  }

  /** True unless a later query in the same chain continues from this one (`cy.get(a).click().find(b)`). */
  private isOutermostQuery(call: ts.CallExpression): boolean {
    let node: ts.Node = call;
    for (;;) {
      while (ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent)) node = node.parent;
      const parent = node.parent;
      if (!(ts.isPropertyAccessExpression(parent) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent)) return true;
      const next = parent.parent;
      const name = parent.name.text;
      if (this.isQueryName(name, next)) return this.isResetCall(next);
      if (!PASS_THROUGH_METHODS.has(name)) return true;
      node = next;
    }
  }

  /** True when the expression is (or is chained on) the global `cy`. */
  private isCypressChain(expr: ts.Expression): boolean {
    let cur = unwrapNoAwait(expr);
    for (;;) {
      if (ts.isIdentifier(cur)) return cur.text === 'cy';
      if (ts.isCallExpression(cur)) cur = unwrapNoAwait(cur.expression);
      else if (ts.isPropertyAccessExpression(cur)) cur = unwrapNoAwait(cur.expression);
      else return false;
    }
  }

  private chainFrom(call: ts.CallExpression): LocatorUse | null {
    const cacheable = this.bindings.size === 0;
    if (cacheable && this.chainCache.has(call)) return this.chainCache.get(call)!;
    if (this.inProgress.has(call)) return null;
    this.inProgress.add(call);
    const use = this.buildChain(call);
    this.inProgress.delete(call);
    if (cacheable) this.chainCache.set(call, use);
    return use;
  }

  private buildChain(call: ts.CallExpression): LocatorUse | null {
    if (this.isIgnored(call)) return null;

    // Collect the query parts from the innermost to the outermost, skipping actions that keep the subject.
    let parts: ts.CallExpression[] = [];
    let cur: ts.Expression = call;
    for (;;) {
      const u = unwrapNoAwait(cur);
      const name = ts.isCallExpression(u) ? methodName(u) : undefined;
      if (!name || !ts.isCallExpression(u)) break;
      if (this.isQueryName(name, u)) parts.unshift(u);
      else if (!PASS_THROUGH_METHODS.has(name)) break;
      cur = (u.expression as ts.PropertyAccessExpression).expression;
    }
    const root = unwrapNoAwait(cur);
    const cypress = this.isCypressChain(root);

    // A chain that does not start from `cy` must start from a known locator (page object getter, variable...).
    const rootBase = cypress ? null : this.locatorOfExpression(root);
    if (!cypress && !rootBase) return null; // not a Cypress chain (e.g. array.find())

    let base: LocatorUse | null = null;
    let baseNote: string | undefined;
    const resetAt = parts.map((p) => this.isResetCall(p)).lastIndexOf(true);
    if (resetAt >= 0) parts = parts.slice(resetAt);
    const first = parts[0];
    const alias = first && methodName(first) === 'get' && first.arguments[0] ? this.resolveString(first.arguments[0]) : undefined;

    if (alias?.startsWith('@')) {
      base = this.aliasLocator(alias.slice(1), first);
      baseNote = `Alias ${alias}`;
      parts = parts.slice(1);
    } else if (resetAt >= 0 || ts.isIdentifier(root)) {
      // cy.get() / cy.contains() inside .within() are scoped to its subject.
      base = this.withinSubject(call);
    } else if (rootBase) {
      base = rootBase;
    } else if (ts.isCallExpression(root)) {
      // cy.wrap(subject) / cy.root(): continue from that subject when it is known.
      const rootName = methodName(root);
      if (rootName === 'wrap' && root.arguments[0]) base = this.locatorOfExpression(root.arguments[0]);
      else if (rootName && CY_ROOT_QUERIES.has(rootName)) base = this.withinSubject(call);
    }

    const hasSource = parts.some((p) => {
      const name = methodName(p)!;
      return SOURCE_METHODS.has(name) || TESTING_LIBRARY_RE.test(name) || this.commandOf(p)?.query === true;
    });
    if (!hasSource && !base) return null;

    let score = base?.score ?? 0;
    let extra = 0;
    const findings: Finding[] = [];
    if (base) {
      const via = baseNote ? `${baseNote}: ` : 'Derived from ';
      findings.push({ rule: 'inherited', points: 0, message: `${via}${base.code} (${path.basename(base.file)}:${base.line})` });
      findings.push(...base.findings.filter((f) => f.rule !== 'inherited'));
    }
    let scoped = base !== null;
    for (const part of parts) {
      const r = this.scorePart(part, scoped);
      if (r.base !== undefined) score = Math.max(score, r.base);
      extra += r.extra ?? 0;
      findings.push(...r.findings);
      scoped = true;
    }

    return this.makeUse(call, clamp(score + extra), findings, base ? [base.id, ...base.ancestors] : []);
  }

  /** The subject of the enclosing `.within()` callback, if any. */
  private withinSubject(node: ts.Node): LocatorUse | null {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isCallExpression(n.parent) &&
        n.parent.arguments.includes(n) && methodName(n.parent) === 'within') {
        return this.locatorOfExpression((n.parent.expression as ts.PropertyAccessExpression).expression);
      }
      if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isSourceFile(n)) return null;
    }
    return null;
  }

  private scorePart(call: ts.CallExpression, scoped: boolean): PartScore {
    const name = methodName(call)!;
    const [arg0, arg1] = call.arguments;
    const ctx = this.ctx;
    const one = (rule: RuleId, detail?: string): PartScore => {
      const f = ctx.finding(rule, detail);
      return { base: f.points, findings: [f] };
    };
    const selector = (arg: ts.Expression | undefined, scopedSel: boolean): PartScore => {
      if (!arg) return one('unresolved');
      const value = this.resolveString(arg);
      if (value !== undefined) {
        const r = scoreCss(value, ctx, scopedSel);
        return { base: r.score, findings: r.findings };
      }
      return one('unresolved', arg.getText());
    };

    const tl = TESTING_LIBRARY_RE.exec(name);
    if (tl) {
      const kind = tl[1];
      if (kind === 'Role') {
        const named = arg1 !== undefined && (!ts.isObjectLiteralExpression(arg1) ||
          arg1.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === 'name'));
        const role = arg0 ? this.resolveString(arg0) : undefined;
        return one(named ? 'role-named' : 'role-unnamed', role ? `role "${role}"` : undefined);
      }
      if (kind === 'Text' || kind === 'DisplayValue') return fromScored(scoreText(arg0 && this.resolveString(arg0), ctx));
      return one(TESTING_LIBRARY_RULES[kind]);
    }

    switch (name) {
      case 'get':
      case 'find':
        return selector(arg0, scoped);
      case 'filter':
        return arg0 && this.isStringish(arg0) ? selector(arg0, true) : { findings: [] };
      case 'contains': {
        const hasSelector = arg1 !== undefined && !ts.isObjectLiteralExpression(unwrap(arg1));
        const content = hasSelector ? arg1 : arg0;
        const text = fromScored(scoreText(content && this.resolveString(content), ctx));
        if (!hasSelector) return text;
        const sel = selector(arg0, scoped);
        return { base: Math.max(text.base!, sel.base!), findings: [...text.findings, ...sel.findings] };
      }
      case 'xpath': {
        const value = arg0 && this.resolveString(arg0);
        return value !== undefined ? fromScored(scoreXPath(value, ctx)) : one('unresolved', arg0?.getText());
      }
      case 'eq': {
        const f = ctx.finding('nth', `.eq(${arg0?.getText() ?? ''})`);
        return { extra: f.points, findings: [f] };
      }
      case 'first':
      case 'last': {
        const f = ctx.finding('first-last', `.${name}()`);
        return { extra: f.points, findings: [f] };
      }
      case 'children': {
        const f = arg0 ? ctx.finding('child-combinator', '.children()') : ctx.finding('dom-traversal', '.children()');
        const sel = arg0 ? selector(arg0, true) : { findings: [] };
        return { base: sel.base, extra: f.points, findings: [...sel.findings, f] };
      }
      case 'not':
      case 'shadow':
        return { findings: [] };
    }

    if (TRAVERSAL_METHODS.has(name)) {
      const f = ctx.finding('dom-traversal', `.${name}()`);
      const sel = arg0 && this.isStringish(arg0) ? selector(arg0, true) : { findings: [] };
      return { base: sel.base, extra: f.points, findings: [...sel.findings, f] };
    }

    const cmd = this.commandOf(call);
    if (cmd?.query && !this.inProgress.has(cmd.fn)) {
      const inner = this.withCommand(cmd, call, () => this.returnedLocator(cmd.fn));
      if (inner) {
        const note: Finding = { rule: 'inherited', points: 0, message: `Custom command cy.${cmd.name}(): ${inner.code} (${path.basename(inner.file)}:${inner.line})` };
        return { base: inner.score, findings: [...inner.findings.filter((f) => f.rule !== 'inherited'), note] };
      }
    }
    return one('unresolved', `${name}()`);
  }

  private makeUse(node: ts.Node, score: number, findings: Finding[], ancestors: string[]): LocatorUse {
    const sf = node.getSourceFile();
    const start = node.getStart();
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    const file = path.resolve(sf.fileName);
    return {
      id: `${file}:${start}${this.idSuffix}`,
      file,
      line: line + 1,
      column: character + 1,
      code: snippet(node),
      score,
      grade: gradeOf(score),
      findings: dedupeFindings(findings),
      ancestors,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private resolveString(expression: ts.Expression, depth = 0): string | undefined {
    if (depth > 8) return undefined;
    const expr = unwrap(expression);
    if (ts.isStringLiteralLike(expr)) return expr.text;
    if (ts.isNumericLiteral(expr)) return expr.text;
    if (ts.isRegularExpressionLiteral(expr)) return expr.text;
    if (ts.isTemplateExpression(expr)) {
      let out = expr.head.text;
      let staticText = expr.head.text;
      for (const span of expr.templateSpans) {
        const v = this.resolveString(span.expression, depth + 1);
        out += (v ?? 'X') + span.literal.text;
        staticText += (v ?? '') + span.literal.text;
      }
      return staticText.trim() ? out : undefined;
    }
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.resolveString(expr.left, depth + 1);
      const r = this.resolveString(expr.right, depth + 1);
      if (l === undefined && r === undefined) return undefined;
      return (l ?? 'X') + (r ?? 'X');
    }
    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      const target = ts.isElementAccessExpression(expr) ? expr.argumentExpression : expr;
      const decl = ts.isElementAccessExpression(expr) ? this.elementDeclaration(expr) : this.declarationOf(target);
      if (!decl) return undefined;
      const bound = this.bindings.get(decl);
      if (bound) return this.resolveString(bound.expr, depth + 1);
      if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isEnumMember(decl)) && decl.initializer) {
        return this.resolveString(decl.initializer, depth + 1);
      }
      if (ts.isPropertyDeclaration(decl)) {
        const value = decl.initializer ?? this.constructorAssignment(decl);
        return value ? this.resolveString(value, depth + 1) : undefined;
      }
      const assigned = assignedValue(decl);
      if (assigned) return this.resolveString(assigned, depth + 1);
    }
    return undefined;
  }

  private elementDeclaration(expr: ts.ElementAccessExpression): ts.Declaration | undefined {
    if (!ts.isStringLiteralLike(expr.argumentExpression)) return undefined;
    const type = this.checker.getTypeAtLocation(expr.expression);
    const prop = type.getProperty(expr.argumentExpression.text);
    const decl = prop?.valueDeclaration ?? prop?.declarations?.[0];
    return decl && !this.isExternal(decl) ? decl : undefined;
  }

  private isStringish(expr: ts.Expression): boolean {
    const e = unwrap(expr);
    if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e)) return true;
    if (ts.isObjectLiteralExpression(e) || ts.isNumericLiteral(e) || ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return false;
    if (this.resolveString(e) !== undefined) return true;
    const type = this.checker.getTypeAtLocation(e);
    return (type.flags & ts.TypeFlags.StringLike) !== 0;
  }

  private isExternal(node: ts.Node): boolean {
    const sf = node.getSourceFile();
    return sf.isDeclarationFile || this.program.isSourceFileFromExternalLibrary(sf) || /[\\/]node_modules[\\/]/.test(sf.fileName);
  }

  private isIgnored(node: ts.Node): boolean {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    const lines = sf.text.split(/\r?\n/);
    return (lines[line]?.includes(IGNORE_MARKER) ?? false) || (line > 0 && (lines[line - 1]?.includes(IGNORE_MARKER) ?? false));
  }
}

// ---------------------------------------------------------------------------
// AST utilities
// ---------------------------------------------------------------------------

/** JS `this.x = value`: TypeScript reports either the assignment or its left side as the declaration. */
function assignedValue(decl: ts.Node): ts.Expression | undefined {
  const assignment = ts.isBinaryExpression(decl) ? decl : ts.isBinaryExpression(decl.parent) ? decl.parent : undefined;
  if (!assignment || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  return assignment.left === decl || assignment === decl ? assignment.right : undefined;
}

function fromScored(r: ScoredSelector): PartScore {
  return { base: r.score, findings: r.findings };
}

/** The function only returns an expression: `(sel) => cy.get(sel)` or `{ return cy.get(sel) }`. */
function returnsOnly(fn: FnNode): boolean {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return true;
  const statements = fn.body.statements;
  return statements.length === 1 && ts.isReturnStatement(statements[0]) && statements[0].expression !== undefined;
}

function methodName(call: ts.CallExpression): string | undefined {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
}

function isCallee(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isPropertyDeclaration(p) ||
    ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) ||
    ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isGetAccessorDeclaration(p)) && p.name === id) return false;
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p)) return false;
  return true;
}

function unwrapNoAwait(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = unwrapNoAwait(e);
  while (ts.isAwaitExpression(cur)) cur = unwrapNoAwait(cur.expression);
  return cur;
}

function dottedName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const left = dottedName(e.expression);
    return left ? `${left}.${e.name.text}` : undefined;
  }
  return undefined;
}

function titleOf(e: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.getText().slice(1, -1);
  return undefined;
}

function snippet(node: ts.Node): string {
  // Multi-line chains (`cy.get(x)\n  .eq(1)`) are joined without the line break.
  const text = node.getText().replace(/\n\s*\./g, '.').replace(/\s+/g, ' ').replace(/^await /, '');
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.rule}|${f.message}`;
    const prev = seen.get(key);
    if (!prev || f.points > prev.points) seen.set(key, f);
  }
  const list = [...seen.values()];
  const inherited = list.filter((f) => f.rule === 'inherited');
  return [...list.filter((f) => f.rule !== 'inherited').sort((a, b) => b.points - a.points), ...inherited];
}
