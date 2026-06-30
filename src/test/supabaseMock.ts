import { vi } from "vitest";

/** Default rpc stub — matches create_customer_request and other SECURITY DEFINER RPCs in unit tests. */
export const mockSupabaseRpc = vi.fn().mockResolvedValue({ data: "order-1", error: null });

export function createSupabaseQueryChain() {
  const chain = {
    select: vi.fn(function select() {
      return chain;
    }),
    eq: vi.fn(function eq() {
      return chain;
    }),
    is: vi.fn(async () => ({ count: 0, error: null })),
    in: vi.fn(function inn() {
      return chain;
    }),
    order: vi.fn(function order() {
      return chain;
    }),
    limit: vi.fn(async () => ({ data: [], error: null, count: 0 })),
    delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
    update: vi.fn(() => {
      const updateChain = {
        eq: vi.fn(function eq() {
          return updateChain;
        }),
        then: (cb: (r: { error: null }) => void) => {
          cb({ error: null });
          return Promise.resolve({ error: null });
        },
      };
      return updateChain;
    }),
    insert: vi.fn().mockResolvedValue({ error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  return chain;
}

export function createMockSupabaseClient() {
  return {
    from: vi.fn(() => createSupabaseQueryChain()),
    rpc: mockSupabaseRpc,
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  };
}
