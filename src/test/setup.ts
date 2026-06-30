import "@testing-library/jest-dom";
import { mockSupabaseRpc } from "./supabaseMock";

// Reset shared rpc stub between test files that use createMockSupabaseClient().
mockSupabaseRpc.mockResolvedValue({ data: "order-1", error: null });

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
