import { test, expect } from '@playwright/test';
import {
  checkExistingAccount,
  uniqueTestPhone,
  cleanupSession38Data,
  supabaseAdmin,
} from './helpers/session38';

const EXISTING_PHONE = uniqueTestPhone('88004');
const ZERO_ORDERS_PHONE = uniqueTestPhone('88005');
const UNKNOWN_PHONE = uniqueTestPhone('88006');

test.beforeAll(async () => {
  await supabaseAdmin.from('users').insert([
    { phone: EXISTING_PHONE, total_orders: 3, completed_orders: 2 },
    { phone: ZERO_ORDERS_PHONE, total_orders: 0, completed_orders: 0 },
  ]);
});

test.afterAll(async () => {
  await cleanupSession38Data([EXISTING_PHONE, ZERO_ORDERS_PHONE, UNKNOWN_PHONE]);
});

test('RECOV-01: checkExistingAccount returns user row when total_orders > 0', async () => {
  const result = await checkExistingAccount(EXISTING_PHONE);

  expect(result).not.toBeNull();
  expect(result!.total_orders).toBe(3);
  expect(result!.completed_orders).toBe(2);
});

test('RECOV-02: checkExistingAccount returns null when phone does not exist', async () => {
  const result = await checkExistingAccount(UNKNOWN_PHONE);
  expect(result).toBeNull();
});

test('RECOV-03: checkExistingAccount returns null when phone exists but total_orders = 0', async () => {
  const result = await checkExistingAccount(ZERO_ORDERS_PHONE);
  expect(result).toBeNull();
});
