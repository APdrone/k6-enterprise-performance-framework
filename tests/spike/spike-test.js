import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { generateK6HtmlReport } from '../../src/utils/html-reporter.js';
import envConfig from '../../config/environments/dev.js';
import thresholds from '../../config/thresholds/spike-thresholds.js';

export const options = {
  stages: [
    { duration: '3s', target: 5 },   // Normal baseline
    { duration: '4s', target: 80 },  // Steep Sudden Spike (Flash Drop)
    { duration: '6s', target: 80 },  // Sustained Spike
    { duration: '3s', target: 5 },   // Rapid Scale-down
  ],
  thresholds: thresholds,
  userAgent: 'K6-Spike-Runner/v2.0',
};

export default function () {
  const baseUrl = envConfig.baseUrl;
  const res = http.get(`${baseUrl}/api/products`);
  check(res, {
    'spike: status 200': (r) => r.status === 200,
  });
  sleep(0.2);
}

export function handleSummary(data) {
  return {
    'reports/spike-test-report.html': generateK6HtmlReport(data, "Flash-Sale Sudden Spike Surge Benchmark"),
    'reports/spike-test-summary.json': JSON.stringify(data, null, 2)
  };
}
