export default {
  http_req_duration: ['p(95)<400', 'p(99)<700'],
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.95']
};
