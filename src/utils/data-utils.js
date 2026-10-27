import { sleep } from 'k6';

export function getRandomItem(array) {
  if (!array || array.length === 0) return null;
  return array[Math.floor(Math.random() * array.length)];
}

export function generateRandomString(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let res = '';
  for (let i = 0; i < length; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

export function generateIdempotencyKey() {
  return 'idem_' + Date.now() + '_' + generateRandomString(6);
}

export function addThinkTime(min = 1, max = 2) {
  const thinkTime = Math.random() * (max - min) + min;
  sleep(thinkTime);
}
