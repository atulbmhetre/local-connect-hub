import type { Page, Route } from '@playwright/test';

export type RouteMatch = (url: string, method: string) => boolean;

export type AbortRouteOptions =
  | { mode: 'fail-then-succeed'; failCount: number }
  | { mode: 'always-fail' };

export type AbortRouteHandle = {
  /** Times the matcher saw a request we aborted (or attempted to abort). */
  abortedCount: () => number;
  /** Times the matcher let a request through via continue(). */
  continuedCount: () => number;
  unroute: () => Promise<void>;
};

/**
 * Intercept matching HTTP requests and abort them to simulate network failure.
 * Use fail-then-succeed to prove retry recovery; always-fail for exhaustion UI.
 */
export async function installAbortRoute(
  page: Page,
  urlPattern: string | RegExp,
  match: RouteMatch,
  options: AbortRouteOptions,
): Promise<AbortRouteHandle> {
  let aborted = 0;
  let continued = 0;

  const handler = async (route: Route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();

    if (!match(url, method)) {
      await route.continue();
      return;
    }

    if (options.mode === 'always-fail') {
      aborted += 1;
      await route.abort('failed');
      return;
    }

    if (aborted < options.failCount) {
      aborted += 1;
      await route.abort('failed');
      return;
    }

    continued += 1;
    const response = await route.fetch();
    await route.fulfill({ response });
  };

  await page.route(urlPattern, handler);

  return {
    abortedCount: () => aborted,
    continuedCount: () => continued,
    unroute: () => page.unroute(urlPattern, handler),
  };
}

export function isVendorByIdFetch(url: string, method: string, vendorId: string): boolean {
  if (method !== 'GET' || !url.includes('/rest/v1/vendors')) return false;
  return (
    url.includes(vendorId) ||
    url.includes(`id=eq.${vendorId}`) ||
    url.includes(`id=eq.${encodeURIComponent(vendorId)}`)
  );
}

/** Primary MyOrders.load() list query (non-done orders with vendor join). */
export function isMyOrdersListFetch(url: string, method: string): boolean {
  if (method !== 'GET' || !url.includes('/rest/v1/requests')) return false;
  const hasVendorJoin =
    url.includes('vendors%28shop_name') || url.includes('vendors(shop_name');
  const hasIdentityFilter =
    url.includes('user_phone=eq.') || url.includes('device_id=eq.');
  const hasOpenStatusFilter =
    url.includes('status=neq.done') || url.includes('status=not.eq.done');
  return hasVendorJoin && hasIdentityFilter && hasOpenStatusFilter;
}

export function isVendorUpdateOwnRpc(url: string, method: string): boolean {
  return method === 'POST' && url.includes('/rest/v1/rpc/vendor_update_own');
}
