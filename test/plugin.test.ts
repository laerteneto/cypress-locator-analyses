import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import locatorAnalyses, { analyzeRun } from '../src/plugin';

const root = path.join(__dirname, '..');
const spec = path.join(__dirname, 'fixtures', 'cart.cy.ts');
const config = { projectRoot: root, supportFile: false as const };
const results = {
  runs: [{
    spec: { absolute: spec },
    tests: [
      { title: ['Cart', 'checkout via page object'], state: 'failed', attempts: [{ state: 'failed' }, { state: 'failed' }] },
      { title: ['Cart', 'robust test'], state: 'passed', attempts: [{ state: 'failed' }, { state: 'passed' }] },
      { title: ['Cart', 'nested', 'uses getter and constant'], state: 'passed', attempts: [{ state: 'passed' }] },
      { title: ['outside describe has no hook'], state: 'pending', attempts: [] },
    ],
  }],
};

describe('plugin', () => {
  it('attaches the outcome of each test of the run', () => {
    const analysis = analyzeRun(results, config, { quiet: true })!;
    const byTitle = (t: string) => analysis.report.tests.find((x) => x.title === t)!;
    expect(byTitle('checkout via page object')).toMatchObject({ outcome: 'unexpected', retries: 1 });
    expect(byTitle('robust test')).toMatchObject({ outcome: 'flaky', retries: 1 });
    expect(byTitle('uses getter and constant')).toMatchObject({ outcome: 'expected', retries: 0 });
    expect(byTitle('outside describe has no hook').outcome).toBeUndefined();
    expect(analysis.failed).toBe(false);
  });

  it('writes the reports relative to the project root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cypress-locator-analyses-'));
    analyzeRun(results, { projectRoot: dir }, { quiet: true, outputFile: 'out/report.json', htmlFile: 'out/report.html' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'out', 'report.json'), 'utf8')).tests).toHaveLength(4);
    expect(fs.readFileSync(path.join(dir, 'out', 'report.html'), 'utf8')).toContain('<h1>Locator fragility</h1>');
  });

  it('registers after:run and throws when failOnRisk is reached', () => {
    const on = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    locatorAnalyses(on, config, { quiet: true, failOnRisk: 90 });
    expect(on).toHaveBeenCalledWith('after:run', expect.any(Function));
    const handler = on.mock.calls[0][1];
    expect(() => handler(results)).toThrow(/3 test\(s\) with risk >= 90/);
    log.mockRestore();
  });

  it('does nothing when the run has no specs', () => {
    expect(analyzeRun({ runs: [] }, config)).toBeUndefined();
    expect(analyzeRun(undefined, config)).toBeUndefined();
  });
});
