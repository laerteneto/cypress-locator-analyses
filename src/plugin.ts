import fs from 'fs';
import path from 'path';
import { analyzeFiles, AnalyzeOptions } from './analyzer';
import { emitReport, OutputOptions } from './output';
import { buildReport, FragilityReport, Outcome } from './report';

export interface LocatorAnalysesOptions extends AnalyzeOptions, OutputOptions {
  /** Minimum locator score to be listed as "worth fixing". Default 30. */
  hotspotMinScore?: number;
}

/** The parts of Cypress' `after:run` results this plugin reads. */
export interface RunResults {
  runs?: Array<{
    spec: { absolute: string };
    tests?: Array<{ title: string[]; state: string; attempts?: Array<{ state: string }> }> | null;
  }>;
}

/** The parts of Cypress' plugin config this plugin reads. */
export interface PluginConfig {
  projectRoot?: string;
  supportFile?: string | false;
}

/**
 * Cypress' `on` from setupNodeEvents. Typed loosely so this package does not need Cypress' types
 * (Cypress.PluginEvents is an overloaded function that no narrower signature accepts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type On = (event: any, handler: (results: any) => void) => unknown;

export interface RunAnalysis {
  report: FragilityReport;
  /** True when a test reached `failOnRisk`. */
  failed: boolean;
}

/**
 * Cypress plugin. After `cypress run`, statically analyzes the selectors used by every spec of the run
 * (including page objects, custom commands and aliases) and prints a ranking of the tests most likely to break.
 *
 *   setupNodeEvents(on, config) {
 *     locatorAnalyses(on, config, { htmlFile: 'fragility-report.html' });
 *     return config;
 *   }
 */
export default function locatorAnalyses(on: On, config: PluginConfig, options: LocatorAnalysesOptions = {}): void {
  on('after:run', (results: RunResults) => {
    const analysis = analyzeRun(results, config, options);
    if (analysis?.failed) {
      // after:run cannot set the exit code of `cypress run`; an error thrown here makes it exit with 1.
      const count = analysis.report.tests.filter((t) => t.risk >= options.failOnRisk!).length;
      const error = new Error(`[cypress-locator-analyses] ${count} test(s) with risk >= ${options.failOnRisk} (failOnRisk).`);
      error.stack = error.message; // the stack trace only adds noise to Cypress' output
      throw error;
    }
  });
}

/**
 * Analyzes the specs of a finished run. Use it directly if another plugin already handles `after:run`
 * (Cypress keeps only one handler per event):
 *
 *   on('after:run', (results: RunResults) => { otherPlugin(results); analyzeRun(results, config, options); });
 */
export function analyzeRun(results: RunResults | undefined, config: PluginConfig, options: LocatorAnalysesOptions = {}): RunAnalysis | undefined {
  const runs = results?.runs ?? [];
  const files = [...new Set(runs.map((r) => path.resolve(r.spec.absolute)))];
  if (files.length === 0) return undefined;

  const rootDir = config.projectRoot ?? process.cwd();
  let report: FragilityReport;
  try {
    const tests = analyzeFiles(files, {
      ...options,
      cwd: options.cwd ?? rootDir,
      supportFiles: options.supportFiles ?? (config.supportFile ? [config.supportFile] : undefined),
    });
    report = buildReport(tests, { rootDir, hotspotMinScore: options.hotspotMinScore });
  } catch (error) {
    console.error('[cypress-locator-analyses] Failed to analyze tests:', error);
    return undefined;
  }

  // Attach what actually happened in this run (failed / flaky) to each static test.
  const byTitle = new Map<string, Array<{ state: string; attempts: number }>>();
  for (const run of runs) {
    const file = realpath(run.spec.absolute);
    for (const t of run.tests ?? []) {
      const key = `${file}|${t.title.join(' > ')}`;
      byTitle.set(key, [...(byTitle.get(key) ?? []), { state: t.state, attempts: t.attempts?.length ?? 1 }]);
    }
  }
  for (const t of report.tests) {
    const ran = (byTitle.get(`${realpath(t.file)}|${t.titlePath.join(' > ')}`) ?? []).filter((r) => r.state !== 'pending' && r.state !== 'skipped');
    if (ran.length === 0) continue;
    t.outcome = worstOutcome(ran.map((r) => (r.state === 'failed' ? 'unexpected' : r.attempts > 1 ? 'flaky' : 'expected')));
    t.retries = Math.max(...ran.map((r) => r.attempts - 1));
  }

  const { failed } = emitReport(report, options);
  return { report, failed };
}

function worstOutcome(outcomes: Outcome[]): Outcome {
  for (const o of ['unexpected', 'flaky', 'expected'] as Outcome[]) if (outcomes.includes(o)) return o;
  return 'skipped';
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}
