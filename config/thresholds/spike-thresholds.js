export default {
  http_req_duration: ['p(95)<800', 'p(99)<1500'],
  http_req_failed: ['rate<0.08'],
  checks: ['rate>0.85']
};
