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

/**
 * VendorMode mount fetch — since the OTP-off read hardening it loads the own
 * vendor row via the get_vendor_own SECURITY DEFINER RPC (POST), not a direct
 * vendors table GET.
 */
export function isGetVendorOwnRpc(url: string, method: string): boolean {
  return method === 'POST' && /\/rest\/v1\/rpc\/get_vendor_own(\?|$)/.test(url);
}

/**
 * MyOrders.load() list fetch — since the OTP-off read hardening it loads via
 * the get_my_orders SECURITY DEFINER RPC (POST), not a direct requests GET.
 * Boundary regex so get_my_order_bills etc. don't match.
 */
export function isGetMyOrdersRpc(url: string, method: string): boolean {
  return method === 'POST' && /\/rest\/v1\/rpc\/get_my_orders(\?|$)/.test(url);
}

export function isVendorUpdateOwnRpc(url: string, method: string): boolean {
  return method === 'POST' && url.includes('/rest/v1/rpc/vendor_update_own');
}

export function isVendorUpdateProfileAndCategoriesRpc(url: string, method: string): boolean {
  return (
    method === 'POST' &&
    url.includes('/rest/v1/rpc/vendor_update_profile_and_categories')
  );
}
