/**
 * Turnkey K6 Performance Test Suite Runner
 * 
 * Orchestrates autonomous mock server lifecycle, executes load,
 * stress, and spike benchmarks, verifies thresholds, and generates HTML reports.
 * 
 * Authored by Aman Patwal (Lead SDET & QA Automation Architect)
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 8090;
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function checkServerReady(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const req = http.get(`http://localhost:${PORT}/healthz`, (res) => {
        if (res.statusCode === 200) {
          clearInterval(interval);
          resolve(true);
        }
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      });
    }, 200);
  });
}

async function main() {
  console.log('================================================================================');
  console.log('🚀 SCRIPTCRUX / K6 DISTRIBUTED E-COMMERCE PERFORMANCE ENGINE');
  console.log('================================================================================');

  let mockProcess = null;
  const isRunning = await checkServerReady(800);

  if (!isRunning) {
    console.log('📡 Starting E-Commerce Flash-Sale Mock Gateway on port 8089...');
    const serverPath = path.join(__dirname, '..', 'src', 'server', 'mock-server.js');
    mockProcess = spawn(process.execPath, [serverPath], { stdio: 'ignore' });
    const ready = await checkServerReady(5000);
    if (!ready) {
      console.error('❌ Failed to bind E-Commerce Mock Gateway.');
      process.exit(1);
    }
    console.log('✅ E-Commerce Flash-Sale Gateway is online.');
  } else {
    console.log('✅ Connected to running E-Commerce Gateway on port 8089.');
  }

  const suites = [
    { name: 'load-test', path: 'tests/load/load-test.js', desc: 'Flash-Sale Concurrency & Order Checkout Load' },
    { name: 'stress-test', path: 'tests/stress/stress-test.js', desc: 'High-Concurrency Inventory Contention Stress' },
    { name: 'spike-test', path: 'tests/spike/spike-test.js', desc: 'Sudden Flash Drop Volume Spike' }
  ];

  console.log('\n🧪 Executing K6 Performance Benchmark Suites...');
  console.log('--------------------------------------------------------------------------------');

  let allPassed = true;

  for (const s of suites) {
    console.log(`\n▶ Running: ${s.desc} [${s.name}]...`);
    const cmd = `k6 run "${path.join(__dirname, '..', s.path)}"`;

    try {
      execSync(cmd, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
      console.log(`  ✓ PASSED: ${s.name} completed successfully.`);
    } catch (err) {
      console.error(`  ✗ FAILED: ${s.name} breached thresholds.`);
      allPassed = false;
    }
  }

  if (mockProcess) {
    mockProcess.kill();
    console.log('\n🛑 Stopped background E-Commerce Mock Gateway.');
  }

  console.log('================================================================================');
  if (allPassed) {
    console.log('🎉 ALL K6 PERFORMANCE QUALITY GATES PASSED (100% COMPLIANT)');
    console.log(`📂 Interactive HTML Dashboards available in: ${REPORTS_DIR}`);
    process.exit(0);
  } else {
    console.error('❌ ONE OR MORE K6 QUALITY GATES BREACHED');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error running K6 suites:', err);
  process.exit(1);
});
