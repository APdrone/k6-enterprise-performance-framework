import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { getRandomItem } from '../../src/utils/data-utils.js';
import { generateK6HtmlReport } from '../../src/utils/html-reporter.js';
import envConfig from '../../config/environments/dev.js';
import thresholds from '../../config/thresholds/stress-thresholds.js';

export const options = {
  stages: [
    { duration: '3s', target: 20 },  // Baseline
    { duration: '8s', target: 60 },  // Push to Stress Threshold
    { duration: '8s', target: 60 },  // Peak Stress Saturation
    { duration: '3s', target: 0 },   // Recovery
  ],
  thresholds: thresholds,
  userAgent: 'K6-Stress-Runner/v2.0',
};

const users = new SharedArray('users', function () {
  return [
    { email: 'stress_user_1@example.com', password: 'password123' },
    { email: 'stress_user_2@example.com', password: 'password123' },
    { email: 'stress_user_3@example.com', password: 'password123' }
  ];
});

export default function () {
  const baseUrl = envConfig.baseUrl;
  const user = getRandomItem(users);

  // High concurrency catalog query
  const res = http.get(`${baseUrl}/api/products/search?q=phone`);
  check(res, {
    'stress search: status 200': (r) => r.status === 200,
    'stress search: latency < 600ms': (r) => r.timings.duration < 600
  });

  // Fast reserve attempt with expected business statuses (201 reserved, 409 out of stock)
  const reserveRes = http.post(`${baseUrl}/api/cart/reserve`, JSON.stringify({
    productId: 1,
    quantity: 1,
    customerId: user.email
  }), {
    headers: { 'Content-Type': 'application/json' },
    responseCallback: http.expectedStatuses(200, 201, 409)
  });

  check(reserveRes, {
    'stress reserve: status 201 or 409': (r) => r.status === 201 || r.status === 409
  });

  sleep(0.3);
}

export function handleSummary(data) {
  return {
    'reports/stress-test-report.html': generateK6HtmlReport(data, "High-Concurrency Stress & Saturation Benchmark"),
    'reports/stress-test-summary.json': JSON.stringify(data, null, 2)
  };
}
