/**
 * Global E-Commerce & Flash-Sale Microservices Mock Gateway
 * 
 * Production-grade simulation of tier-1 distributed e-commerce architecture:
 * 1. Customer Authentication & Tiered RBAC (VIP, Gold, Standard)
 * 2. High-Throughput Product Catalog & Faceted Search
 * 3. Atomic Flash-Sale Inventory Reservation with TTL Locks (Race Condition Testing)
 * 4. Dynamic Promo Code Engine (Discount calculations)
 * 5. Idempotent Two-Phase Checkout & Payment Processing
 * 6. Real-Time Inventory Stock WebSockets (/ws/inventory-stream)
 * 7. Prometheus Telemetry Endpoint (/metrics)
 * 
 * Authored by Aman Patwal (Lead SDET & QA Automation Architect)
 */

const http = require("http");
const url = require("url");
const crypto = require("crypto");
let WebSocket;
try {
  WebSocket = require("ws");
} catch (e) {
  WebSocket = null;
}

const PORT = parseInt(process.env.PORT || "8090", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_LATENCY_MS = parseInt(process.env.SIMULATED_LATENCY_MS || "15", 10);

// In-Memory Database
const inventory = new Map([
  [1, { id: 1, name: "Flagship Smartphone Pro X", category: "Electronics", price: 999.99, stock: 150, reserved: 0, isFlashSale: true }],
  [2, { id: 2, name: "Ultra-Lightweight Laptop 16", category: "Electronics", price: 1499.99, stock: 80, reserved: 0, isFlashSale: true }],
  [3, { id: 3, name: "Active Noise-Cancelling Headphones", category: "Audio", price: 249.99, stock: 300, reserved: 0, isFlashSale: false }],
  [4, { id: 4, name: "Titanium Smartwatch Ultra", category: "Wearables", price: 399.99, stock: 120, reserved: 0, isFlashSale: true }],
  [5, { id: 5, name: "Ergonomic Mechanical Keyboard", category: "Accessories", price: 129.99, stock: 250, reserved: 0, isFlashSale: false }]
]);

const reservations = new Map(); // reservationId -> { id, productId, quantity, customerId, expiresAt, status }
const orders = new Map(); // orderId -> { orderId, customerId, items, total, status, createdAt }
const idempotencyCache = new Map(); // key -> { statusCode, data }

const metrics = {
  requestsTotal: 0,
  requestsByStatus: { 200: 0, 201: 0, 400: 0, 401: 0, 404: 0, 409: 0, 429: 0, 500: 0 },
  reservationsTotal: 0,
  stockOutEvents: 0,
  idempotentReplays: 0,
  ordersCompleted: 0
};

// Periodic Reservation TTL Cleanup (60s lock release)
setInterval(() => {
  const now = Date.now();
  for (const [resId, resv] of reservations.entries()) {
    if (resv.status === "RESERVED" && now > resv.expiresAt) {
      resv.status = "EXPIRED";
      const item = inventory.get(resv.productId);
      if (item) {
        item.reserved = Math.max(0, item.reserved - resv.quantity);
      }
    }
  }
}, 5000);

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function sendJsonResponse(res, statusCode, data, headers = {}) {
  metrics.requestsTotal++;
  metrics.requestsByStatus[statusCode] = (metrics.requestsByStatus[statusCode] || 0) + 1;
  const payload = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "X-Server-Engine": "K6-ECommerce-Core/v2.0",
    "X-Correlation-ID": headers["X-Correlation-ID"] || `corr-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Correlation-ID, Idempotency-Key",
    ...headers
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Correlation-ID, Idempotency-Key"
    });
    return res.end();
  }

  // 1. Healthz
  if (pathname === "/healthz" || pathname === "/health") {
    return sendJsonResponse(res, 200, {
      status: "HEALTHY",
      service: "k6-ecommerce-flashsale-core",
      uptime: process.uptime(),
      activeReservations: Array.from(reservations.values()).filter(r => r.status === "RESERVED").length,
      ordersProcessed: orders.size,
      timestamp: new Date().toISOString()
    });
  }

  // 2. Prometheus Metrics
  if (pathname === "/metrics") {
    const lines = [
      "# HELP http_requests_total Total HTTP requests received",
      "# TYPE http_requests_total counter",
      `http_requests_total ${metrics.requestsTotal}`,
      "# HELP orders_completed_total Total successful checkouts",
      "# TYPE orders_completed_total counter",
      `orders_completed_total ${metrics.ordersCompleted}`,
      "# HELP stock_exhaustion_total Total 409 out-of-stock flash sale lock failures",
      "# TYPE stock_exhaustion_total counter",
      `stock_exhaustion_total ${metrics.stockOutEvents}`,
      "# HELP idempotent_replays_total Total duplicate checkouts served from cache",
      "# TYPE idempotent_replays_total counter",
      `idempotent_replays_total ${metrics.idempotentReplays}`
    ];
    for (const [code, count] of Object.entries(metrics.requestsByStatus)) {
      lines.push(`http_requests_by_status{code="${code}"} ${count}`);
    }
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    return res.end(lines.join("\n"));
  }

  // Latency Jitter
  await new Promise(r => setTimeout(r, BASE_LATENCY_MS + Math.floor(Math.random() * 10)));

  // 3. Auth Login
  if ((pathname === "/api/auth/login" || pathname === "/api/v1/auth/login") && method === "POST") {
    const body = await parseJsonBody(req);
    const email = body.email || "shopper@example.com";
    const isVip = email.includes("vip") || email.includes("admin") || Math.random() < 0.25;

    return sendJsonResponse(res, 200, {
      success: true,
      token: `k6_jwt_${crypto.randomBytes(16).toString("hex")}`,
      user: {
        id: `usr_${Math.floor(1000 + Math.random() * 9000)}`,
        email: email,
        tier: isVip ? "VIP_MEMBER" : "STANDARD_SHOPPER",
        discountMultiplier: isVip ? 0.85 : 1.0
      }
    });
  }

  // 4. Products Search & Catalog
  if ((pathname === "/api/products" || pathname === "/api/v1/products" || pathname === "/api/products/search") && method === "GET") {
    const query = (parsedUrl.query.q || parsedUrl.query.search || "").toLowerCase();
    const category = (parsedUrl.query.category || "").toLowerCase();

    let items = Array.from(inventory.values());
    if (query) {
      items = items.filter(p => p.name.toLowerCase().includes(query) || p.category.toLowerCase().includes(query));
    }
    if (category) {
      items = items.filter(p => p.category.toLowerCase() === category);
    }

    const formatted = items.map(p => ({
      id: p.id,
      name: p.name,
      category: p.category,
      price: p.price,
      availableStock: Math.max(0, p.stock - p.reserved),
      isFlashSale: p.isFlashSale
    }));

    return sendJsonResponse(res, 200, {
      success: true,
      totalCount: formatted.length,
      results: formatted
    });
  }

  // 5. Product Detail by ID
  if (pathname.match(/^\/api(\/v1)?\/products\/\d+$/) && method === "GET") {
    const id = parseInt(pathname.split("/").pop(), 10);
    const item = inventory.get(id);
    if (!item) {
      return sendJsonResponse(res, 404, { error: "PRODUCT_NOT_FOUND" });
    }
    return sendJsonResponse(res, 200, {
      success: true,
      product: {
        ...item,
        availableStock: Math.max(0, item.stock - item.reserved)
      }
    });
  }

  // 6. Flash-Sale Atomic Inventory Reservation
  if ((pathname === "/api/cart/reserve" || pathname === "/api/v1/cart/reserve") && method === "POST") {
    const body = await parseJsonBody(req);
    const productId = parseInt(body.productId, 10) || 1;
    const quantity = parseInt(body.quantity, 10) || 1;
    const item = inventory.get(productId);

    if (!item) {
      return sendJsonResponse(res, 404, { error: "PRODUCT_NOT_FOUND" });
    }

    const available = item.stock - item.reserved;
    if (available < quantity) {
      metrics.stockOutEvents++;
      return sendJsonResponse(res, 409, {
        error: "INSUFFICIENT_STOCK",
        message: "Flash sale inventory exhausted. Cannot fulfill reservation request.",
        availableStock: Math.max(0, available),
        requested: quantity
      });
    }

    // Atomically reserve
    item.reserved += quantity;
    metrics.reservationsTotal++;
    const resId = `resv_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const expiresAt = Date.now() + 60000; // 60s hold

    reservations.set(resId, {
      id: resId,
      productId: productId,
      quantity: quantity,
      unitPrice: item.price,
      customerId: body.customerId || "usr_anon",
      expiresAt: expiresAt,
      status: "RESERVED"
    });

    return sendJsonResponse(res, 201, {
      success: true,
      reservationId: resId,
      expiresAt: new Date(expiresAt).toISOString(),
      reservedQuantity: quantity,
      unitPrice: item.price,
      estimatedSubtotal: Number((quantity * item.price).toFixed(2))
    });
  }

  // 7. Dynamic Promo Code Engine
  if ((pathname === "/api/cart/apply-promo" || pathname === "/api/v1/cart/apply-promo") && method === "POST") {
    const body = await parseJsonBody(req);
    const code = (body.promoCode || "").toUpperCase();
    const subtotal = parseFloat(body.subtotal) || 100.0;

    let discountPct = 0;
    if (code === "FLASH50") discountPct = 50;
    else if (code === "VIP20") discountPct = 20;
    else if (code === "FREESHIP") discountPct = 10;

    const discountAmount = Number(((discountPct / 100) * subtotal).toFixed(2));
    const finalTotal = Number((subtotal - discountAmount).toFixed(2));

    return sendJsonResponse(res, 200, {
      success: true,
      promoCode: code,
      applied: discountPct > 0,
      discountPercentage: discountPct,
      discountAmount: discountAmount,
      finalTotal: finalTotal
    });
  }

  // 8. Two-Phase Order Checkout (Idempotent)
  if ((pathname === "/api/checkout" || pathname === "/api/v1/checkout") && method === "POST") {
    const idempotencyKey = req.headers["idempotency-key"];
    if (idempotencyKey && idempotencyCache.has(idempotencyKey)) {
      metrics.idempotentReplays++;
      const cached = idempotencyCache.get(idempotencyKey);
      return sendJsonResponse(res, cached.statusCode, cached.data, {
        "X-Idempotency-Replay": "true",
        "X-Cache-Lookup": "HIT"
      });
    }

    const body = await parseJsonBody(req);
    const reservationId = body.reservationId;
    let finalAmount = 199.99;

    if (reservationId && reservations.has(reservationId)) {
      const resv = reservations.get(reservationId);
      if (resv.status === "EXPIRED") {
        return sendJsonResponse(res, 410, { error: "RESERVATION_EXPIRED", message: "Inventory hold expired. Please re-reserve." });
      }
      resv.status = "FULFILLED";
      finalAmount = Number((resv.quantity * resv.unitPrice).toFixed(2));
    }

    metrics.ordersCompleted++;
    const orderId = `ord_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const orderRecord = {
      orderId: orderId,
      status: "CONFIRMED",
      paymentStatus: "SETTLED",
      paymentMethod: body.paymentMethod || "STRIPE_INSTANT",
      totalAmountUSD: finalAmount,
      fulfillmentTracking: `trk_fedex_${crypto.randomBytes(4).toString("hex")}`,
      createdAt: new Date().toISOString()
    };

    orders.set(orderId, orderRecord);
    const respData = { success: true, order: orderRecord };

    if (idempotencyKey) {
      idempotencyCache.set(idempotencyKey, { statusCode: 201, data: respData });
    }

    return sendJsonResponse(res, 201, respData);
  }

  // 9. Order Status
  if (pathname.match(/^\/api(\/v1)?\/orders\/[\w-]+$/) && method === "GET") {
    const orderId = pathname.split("/").pop();
    const order = orders.get(orderId) || {
      orderId: orderId,
      status: "IN_TRANSIT",
      paymentStatus: "SETTLED",
      estimatedDelivery: "2-Day Express"
    };
    return sendJsonResponse(res, 200, { success: true, order: order });
  }

  // Fallback 404
  return sendJsonResponse(res, 404, {
    error: "ROUTE_NOT_FOUND",
    message: `Endpoint ${method} ${pathname} not found on E-Commerce Flash-Sale Gateway.`
  });
});

// WebSocket Streaming Feed
let wss = null;
if (WebSocket) {
  wss = new WebSocket.Server({ noServer: true });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "STREAM_CONNECTED", feed: "flash_sale_inventory" }));
    const streamInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const item = inventory.get(Math.floor(1 + Math.random() * 5));
        if (item) {
          ws.send(JSON.stringify({
            type: "STOCK_UPDATE_TICKER",
            productId: item.id,
            productName: item.name,
            availableStock: Math.max(0, item.stock - item.reserved),
            timestamp: new Date().toISOString()
          }));
        }
      }
    }, 2000);
    ws.on("close", () => clearInterval(streamInterval));
  });

  server.on("upgrade", (req, socket, head) => {
    if (url.parse(req.url).pathname === "/ws/inventory-stream") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`========================================================================`);
    console.log(`🛒 SCRIPTCRUX E-COMMERCE & FLASH-SALE CORE GATEWAY ONLINE`);
    console.log(`📡 URL: http://${HOST}:${PORT}`);
    console.log(`🔒 Health: http://localhost:${PORT}/healthz`);
    console.log(`📊 Metrics: http://localhost:${PORT}/metrics`);
    if (WebSocket) console.log(`⚡ WebSocket: ws://localhost:${PORT}/ws/inventory-stream`);
    console.log(`⚡ Features: Atomic TTL Stock Locks, Idempotent Checkout, Promo Engine`);
    console.log(`========================================================================`);
  });
}

module.exports = server;
