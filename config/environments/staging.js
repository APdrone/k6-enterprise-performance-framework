export default {
  baseUrl: __ENV.BASE_URL || 'http://localhost:8090',
  wsUrl: __ENV.WS_URL || 'ws://localhost:8090/ws/inventory-stream',
  environment: 'staging'
};
