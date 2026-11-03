import { defineConfig } from 'cypress';
import locatorAnalyses from '../dist/index.js';

// Runs real browser tests with the plugin, to check it end to end.
// scripts/verify-e2e-report.mjs then asserts on the JSON it writes.
export default defineConfig({
  retries: 1,
  screenshotOnRunFailure: false,
  video: false,
  e2e: {
    setupNodeEvents(on, config) {
      const failOnRisk = process.env.FAIL_ON_RISK ? Number(process.env.FAIL_ON_RISK) : undefined;
      locatorAnalyses(on, config, { outputFile: 'fragility-report.json', htmlFile: 'fragility-report.html', failOnRisk });
      return config;
    },
  },
});
