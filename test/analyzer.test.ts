import path from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeFiles, detectSupportFiles } from '../src/analyzer';
import { buildReport, testRisk } from '../src/report';

const root = path.join(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures');
const supportFiles = [path.join(fixtures, 'support', 'commands.ts')];
const tests = analyzeFiles([path.join(fixtures, 'cart.cy.ts')], { cwd: root, supportFiles });
const features = analyzeFiles([path.join(fixtures, 'features.cy.ts')], { cwd: root, supportFiles });

const finder = (list: typeof tests) => (t: string) => list.find((x) => x.title === t)!;
const byTitle = finder(tests);
const feature = finder(features);
const codes = (t: string) => byTitle(t).uses.map((u) => u.code);
const featureCodes = (t: string) => feature(t).uses.map((u) => u.code);

describe('analyzeFiles', () => {
  it('finds tests with describe/context title paths', () => {
    expect(tests.map((t) => t.titlePath.join(' > '))).toEqual([
      'Cart > checkout via page object',
      'Cart > robust test',
      'Cart > nested > uses getter and constant',
      'outside describe has no hook',
    ]);
    expect(byTitle('checkout via page object').line).toBe(8);
  });

  it('applies beforeEach hooks of enclosing describes', () => {
    expect(codes('robust test')).toContain("cy.xpath('/html/body/div[3]/button')");
    expect(codes('uses getter and constant')).toContain("cy.xpath('/html/body/div[3]/button')");
    expect(codes('outside describe has no hook')).toEqual(["cy.get('[data-cy=ok]')"]);
  });

  it('follows page object methods and constructor-assigned selectors', () => {
    const use = byTitle('checkout via page object').uses.find((u) => u.file.endsWith('cart.page.ts'))!;
    expect(use.code).toBe('cy.get(this.checkoutButton)');
    expect(use.findings.some((f) => f.message.includes('Cart_cta__a9F3k'))).toBe(true);
    expect(use.grade).toBe('F');
  });

  it('resolves getters, inherited chains and constants', () => {
    const c = codes('uses getter and constant');
    expect(c).toContain("this.list.findByRole('listitem').first()");
    // The base `cy.get('[data-cy=cart-list]')` is folded into the derived locator.
    expect(c).not.toContain("cy.get('[data-cy=cart-list]')");
    expect(c).toContain('cy.get(SELECTORS.promo)');
    const promo = byTitle('uses getter and constant').uses.find((u) => u.code.includes('SELECTORS'))!;
    expect(promo.findings.some((f) => f.message.includes('.promo-banner'))).toBe(true);
  });

  it('honours the ignore comment', () => {
    expect(codes('uses getter and constant').some((c) => c.includes('btn-legacy'))).toBe(false);
  });

  it('ranks fragile tests first', () => {
    const report = buildReport(tests);
    const rank = (t: string) => report.tests.findIndex((x) => x.title === t);
    expect(rank('checkout via page object')).toBeLessThan(rank('robust test'));
    expect(rank('uses getter and constant')).toBeLessThan(rank('robust test'));
    expect(report.tests.at(-1)!.title).toBe('outside describe has no hook');
    expect(report.hotspots[0].tests).toBe(3); // the beforeEach XPath affects 3 tests
  });
});

describe('Cypress features', () => {
  it('scores custom query commands with their arguments', () => {
    const uses = feature('custom query commands').uses;
    expect(uses.map((u) => [u.code, u.grade])).toEqual([
      ["cy.getByClass('css-1x2y3z')", 'F'],
      ["cy.getBySel('save')", 'A'],
    ]);
  });

  it('follows custom commands into their steps', () => {
    const uses = feature('custom command with steps').uses;
    expect(uses.map((u) => u.code)).toEqual([
      "cy.get('form > div:nth-child(3) > button')",
      "cy.get('input[type=password]')",
      "cy.get('#email')",
    ]);
    expect(uses.every((u) => u.file.endsWith('commands.ts'))).toBe(true);
  });

  it('resolves aliases', () => {
    const [use] = feature('alias').uses;
    expect(feature('alias').uses).toHaveLength(1);
    expect(use.code).toBe("cy.get('@rows').eq(2)");
    expect(use.findings.some((f) => f.message.startsWith('Alias @rows'))).toBe(true);
    expect(use.findings.some((f) => f.rule === 'nth')).toBe(true);
  });

  it('scopes queries inside .within() to its subject', () => {
    const uses = feature('within').uses;
    expect(uses.map((u) => u.code)).toEqual(["cy.get('input').first()", "cy.contains('Sign in')"]);
    expect(uses[0].findings.some((f) => f.rule === 'tag-scoped')).toBe(true);
    expect(uses.every((u) => u.findings.some((f) => f.message.includes("[data-cy=login-form]")))).toBe(true);
  });

  it('penalizes DOM traversal', () => {
    const [use] = feature('traversal').uses;
    expect(use.findings.filter((f) => f.rule === 'dom-traversal')).toHaveLength(2);
    expect(use.grade).toBe('D');
  });

  it('follows child commands with their subject', () => {
    const uses = feature('child command').uses;
    expect(uses).toHaveLength(1);
    expect(uses[0].code).toBe("cy.wrap(subject).find('tr').eq(index)");
    expect(uses[0].findings.some((f) => f.message.includes("cy.get('[data-cy=orders]')"))).toBe(true);
  });

  it('scores jQuery pseudos and cy.contains with a selector', () => {
    expect(feature('jquery pseudos and contains with selector').uses.map((u) => [u.code, u.score])).toEqual([
      ["cy.get('li:first')", 80],
      ["cy.contains('button', 'Delete')", 55],
    ]);
  });

  it('scores Testing Library queries', () => {
    expect(feature('testing library').uses.map((u) => [u.code, u.score])).toEqual([
      ["cy.findAllByRole('row').eq(1)", 40],
      ["cy.findByLabelText('Email')", 10],
    ]);
  });

  it('ignores arrays, maps and network aliases', () => {
    expect(featureCodes('ignores non-cypress chains')).toEqual([]);
  });

  it('keeps the chain going through actions', () => {
    const [use] = feature('chain continues after an action').uses;
    expect(feature('chain continues after an action').uses).toHaveLength(1);
    expect(use.code).toBe("cy.get('[data-cy=menu]').click().find('a.css-1x2y3z')");
    expect(use.grade).toBe('F');
  });

  it('detects cypress/support from the project of the specs', () => {
    const files = detectSupportFiles([path.join(root, 'example', 'cypress', 'e2e', 'login.cy.ts')], root);
    expect(files.map((f) => path.relative(root, f))).toEqual(['example/cypress/support/commands.ts', 'example/cypress/support/e2e.ts']);
  });
});

describe('testRisk', () => {
  const u = (score: number) => ({ score }) as never;
  it('is ~0 for robust locators and high for a single F', () => {
    expect(testRisk([u(5), u(5), u(10)])).toBeLessThan(2);
    expect(testRisk([u(90)])).toBeGreaterThan(80);
    expect(testRisk([])).toBe(0);
  });
});

describe('JavaScript page objects', () => {
  it('resolves constructor fields and element maps', () => {
    const [test] = analyzeFiles([path.join(fixtures, 'login.cy.js')], { cwd: root, supportFiles: [] });
    expect(test.uses.map((u) => [u.code, u.score])).toEqual([
      ["cy.get('form .btn-primary')", 55],
      ['cy.get(this.emailInput)', 20],
    ]);
  });
});
