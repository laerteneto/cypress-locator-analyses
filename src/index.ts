import locatorAnalyses from './plugin';

export default locatorAnalyses;
export { locatorAnalyses };
export { analyzeRun } from './plugin';
export type { LocatorAnalysesOptions, RunAnalysis, RunResults, PluginConfig } from './plugin';
export { analyzeFiles, detectSupportFiles } from './analyzer';
export type { AnalyzeOptions, LocatorUse, StaticTest } from './analyzer';
export { buildReport, testRisk, toJSON } from './report';
export type { FragilityReport, TestReport, Hotspot } from './report';
export { scoreSelector, scoreCss, scoreXPath, scoreText, classifyClass, isGeneratedId } from './selector';
export { RULES, ScoreContext, gradeOf } from './rules';
export type { RuleId, Grade, Finding, ScoringOptions } from './rules';
export { formatConsole } from './format/console';
export { formatHtml } from './format/html';
export { emitReport } from './output';
