import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import devConfig from '../../config/environments/dev.js';
import soakThresholds from '../../config/thresholds/soak-thresholds.js';
import { generateIdempotencyKey } from '../../src/utils/data-utils.js';
import { generateHtmlReport } from '../../src/utils/html-reporter.js';

// Custom Metrics
const soakLatency = new Trend('soak_journey_duration');
const soakCompleted = new Counter('soak_orders_completed');

export const options = {
  stages: [
    { duration: '10s', target: 10 },  // Ramp up
    { duration: '30s', target: 10 },  // Steady endurance
    { duration: '10s', target: 0 },   // Ramp down
  ],
  thresholds: soakThresholds.thresholds,
};

const BASE_URL = devConfig.baseUrl;

export default function () {
  const startTime = Date.now();

  // 1. Health check & memory probe
  const healthRes = http.get(`${BASE_URL}/healthz`);
  check(healthRes, {
    'system healthy': (r) => r.status === 200,
  });

  // 2. Authentication
  const authPayload = JSON.stringify({
    username: 'flash_buyer_1',
    password: 'Password123!',
  });
  const authRes = http.post(`${BASE_URL}/api/auth/login`, authPayload, {
    headers: { 'Content-Type': 'application/json' },
  });

  const authToken = authRes.json('token');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
  };

  // 3. Catalog Browse
  const searchRes = http.get(`${BASE_URL}/api/products/search?q=phone`, { headers });
  check(searchRes, {
    'catalog returned items': (r) => r.status === 200,
  });

  // 4. Reserve Stock
  const reservePayload = JSON.stringify({
    productId: 'prod-001',
    quantity: 1,
  });

  const reserveRes = http.post(`${BASE_URL}/api/cart/reserve`, reservePayload, {
    headers,
    responseCallback: http.expectedStatuses(200, 201, 409),
  });

  if (reserveRes.status === 201) {
    const reservationId = reserveRes.json('reservationId');

    // 5. Checkout
    const checkoutPayload = JSON.stringify({
      reservationId,
      shippingAddress: { city: 'New York', country: 'USA' },
      paymentMethod: 'CREDIT_CARD',
    });

    const checkoutHeaders = Object.assign({}, headers, {
      'Idempotency-Key': generateIdempotencyKey(),
    });

    const checkoutRes = http.post(`${BASE_URL}/api/checkout`, checkoutPayload, {
      headers: checkoutHeaders,
    });

    if (checkoutRes.status === 200) {
      soakCompleted.add(1);
    }
  }

  soakLatency.add(Date.now() - startTime);
  sleep(1);
}

export function handleSummary(data) {
  return {
    'reports/soak-test-report.html': generateHtmlReport(data, 'Soak Test (Endurance & Memory Leak Analysis)'),
    'reports/soak-test-summary.json': JSON.stringify(data, null, 2),
  };
}
