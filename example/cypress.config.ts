import { defineConfig } from 'cypress';
// In a real project: import locatorAnalyses from 'cypress-locator-analyses';
import locatorAnalyses from '../dist/index.js';

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3000',
    setupNodeEvents(on, config) {
      locatorAnalyses(on, config, { htmlFile: 'fragility-report.html', outputFile: 'fragility-report.json', top: 10 });
      return config;
    },
  },
});
