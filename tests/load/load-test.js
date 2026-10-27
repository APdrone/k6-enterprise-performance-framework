import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { getRandomItem, generateIdempotencyKey, addThinkTime } from '../../src/utils/data-utils.js';
import { generateK6HtmlReport } from '../../src/utils/html-reporter.js';
import envConfig from '../../config/environments/dev.js';
import thresholds from '../../config/thresholds/load-thresholds.js';

// Custom Enterprise Metrics
const loginDuration = new Trend('login_duration');
const reserveDuration = new Trend('inventory_reserve_duration');
const checkoutDuration = new Trend('checkout_duration');
const stockOutCounter = new Counter('stock_exhaustion_count');
const successfulOrders = new Counter('successful_orders');
const successRate = new Rate('success_rate');

// Test Configuration
export const options = {
  stages: [
    { duration: '5s', target: 10 },  // Phase 1: Rapid Warmup
    { duration: '12s', target: 25 }, // Phase 2: Sustained Flash-Sale Traffic
    { duration: '5s', target: 0 },   // Phase 3: Order Flush & Ramp Down
  ],
  thresholds: thresholds,
  userAgent: 'K6-Enterprise-Shopper/v2.0',
};

const users = new SharedArray('users', function () {
  return [
    { email: 'vip_shopper@example.com', password: 'password123', tier: 'VIP_MEMBER' },
    { email: 'gold_shopper@example.com', password: 'password123', tier: 'GOLD' },
    { email: 'standard_shopper@example.com', password: 'password123', tier: 'STANDARD' }
  ];
});

export default function () {
  const baseUrl = envConfig.baseUrl;
  const user = getRandomItem(users);
  let authToken = '';
  let reservationId = '';

  // 1. Customer Authentication Flow
  group('01_Authentication', function () {
    const start = Date.now();
    const res = http.post(`${baseUrl}/api/auth/login`, JSON.stringify({
      email: user.email,
      password: user.password
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
    loginDuration.add(Date.now() - start);

    const ok = check(res, {
      'login: status is 200': (r) => r.status === 200,
      'login: token received': (r) => r.json('token') !== undefined,
    });
    successRate.add(ok);
    if (ok) authToken = res.json('token');
  });

  addThinkTime(0.5, 1);

  // 2. High-Throughput Catalog Search
  group('02_Catalog_Faceted_Search', function () {
    const terms = ['smartphone', 'laptop', 'headphones', 'watch'];
    const q = getRandomItem(terms);
    const res = http.get(`${baseUrl}/api/products/search?q=${q}`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }
    });

    const ok = check(res, {
      'search: status is 200': (r) => r.status === 200,
      'search: results found': (r) => Array.isArray(r.json('results')),
    });
    successRate.add(ok);
  });

  addThinkTime(0.5, 1);

  // 3. Flash-Sale Atomic Inventory Reservation (Race Condition & Lock Test)
  group('03_Inventory_Reservation', function () {
    const start = Date.now();
    const res = http.post(`${baseUrl}/api/cart/reserve`, JSON.stringify({
      productId: 1, // High-demand Flagship Smartphone Pro X
      quantity: 1,
      customerId: user.email
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }
    });
    reserveDuration.add(Date.now() - start);

    const isReserved = res.status === 201;
    const isOutOfStock = res.status === 409;

    const ok = check(res, {
      'reserve: 201 Reserved OR 409 Sold Out': (r) => isReserved || isOutOfStock,
    });
    successRate.add(ok);

    if (isReserved) {
      reservationId = res.json('reservationId');
    } else if (isOutOfStock) {
      stockOutCounter.add(1);
    }
  });

  // 4. Two-Phase Order Checkout with Idempotency Key
  if (reservationId) {
    group('04_Idempotent_Checkout', function () {
      const idempotencyKey = generateIdempotencyKey();
      const start = Date.now();
      const res = http.post(`${baseUrl}/api/checkout`, JSON.stringify({
        reservationId: reservationId,
        paymentMethod: 'STRIPE_INSTANT'
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
          'Idempotency-Key': idempotencyKey
        }
      });
      checkoutDuration.add(Date.now() - start);

      const ok = check(res, {
        'checkout: status is 201': (r) => r.status === 201,
        'checkout: order confirmed': (r) => r.json('order.orderId') !== undefined,
      });
      successRate.add(ok);
      if (ok) successfulOrders.add(1);
    });
  }

  sleep(0.5);
}

export function handleSummary(data) {
  return {
    'reports/load-test-report.html': generateK6HtmlReport(data, "Flash-Sale Concurrency Benchmark"),
    'reports/load-test-summary.json': JSON.stringify(data, null, 2),
    stdout: `\n================================================================================\n` +
            `🎉 K6 FLASH-SALE LOAD TEST COMPLETED\n` +
            `  • Total Requests: ${data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0}\n` +
            `  • p95 Latency: ${data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(95)'].toFixed(1) : 0}ms\n` +
            `  • Check Pass Rate: ${(data.metrics.checks ? data.metrics.checks.values.rate * 100 : 100).toFixed(2)}%\n` +
            `📂 Reports saved to: ./reports/load-test-report.html\n` +
            `================================================================================\n`
  };
}
