export default {
  http_req_duration: ['p(95)<600', 'p(99)<1200'],
  http_req_failed: ['rate<0.05'],
  checks: ['rate>0.90']
};
