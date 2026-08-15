import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ParchiSheet } from '../ParchiSheet';
import { strings } from '@/lib/strings';
import type { Vendor } from '@/lib/supabase';

window.scrollTo = vi.fn();
Element.prototype.scrollTo = vi.fn();

const mockMenuItems = [
  {
    id: 'item-1',
    name: 'Veg Curry',
    description: 'Spicy curry',
    price: 50,
    unit: 'plate',
    is_available: true,
    category_id: null,
    image_url: null,
  },
  {
    id: 'item-2',
    name: 'Rice',
    description: 'Basmati',
    price: 30,
    unit: 'bowl',
    is_available: true,
    category_id: null,
    image_url: null,
  },
];

const menuOrderMock = vi.fn();
const vendorMenuFromMock = vi.fn();
const mockRpc = vi.fn();
const mockFetchUserTrust = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => vendorMenuFromMock(table),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
  fetchUserTrust: (...args: unknown[]) => mockFetchUserTrust(...args),
  invokeNotifyVendor: vi.fn(),
  upsertUser: vi.fn(),
  incrementUserOrders: vi.fn(),
  SUPABASE_URL: 'http://test',
  SUPABASE_ANON_KEY: 'test',
}));

vi.mock('@/lib/language', () => ({
  useLanguage: () => ({ s: strings.en, lang: 'en' as const, setLang: () => {} }),
}));

vi.mock('@/hooks/useAppConfig', () => ({
  useAppConfig: () => ({
    config: { maxOrderMessageChars: 500, helpAcceptTimeoutHours: 2 },
    loading: false,
  }),
}));

vi.mock('@/hooks/useUserAddresses', () => ({
  useUserAddresses: () => ({
    addresses: [{ id: 'addr-1', address_text: '12 Test Lane', is_default: true }],
    loading: false,
  }),
}));

vi.mock('@/lib/userIdentity', () => ({
  getUserPhone: () => '9876543210',
  isPhoneKnown: () => true,
  migrateUserPhone: vi.fn(),
}));

vi.mock('@/lib/deviceId', () => ({
  getDeviceId: () => 'device-test',
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
}));

const deliveryVendor = {
  id: 'vendor-delivery-1',
  name: 'Delivery Vendor',
  shop_name: 'Fresh Mart',
  category: 'Grocery',
  upi_id: 'test@upi',
  phone: '8888169446',
  is_active: true,
  latitude: 18.5,
  longitude: 73.8,
  verification_status: 'business_verified',
  shop_photo_url: null,
  upi_verified: false,
  is_manual_verified: false,
  created_at: new Date().toISOString(),
  service_mode: 'delivery',
  cancel_reason_1: null,
  cancel_reason_2: null,
  cancel_reason_3: null,
  cancel_reason_4: null,
  service_radius_km: 15,
  serves_at_vendor_place: false,
  serves_at_customer_place: true,
} as Vendor;

function renderParchi(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function setupMenuFromMock() {
  menuOrderMock.mockResolvedValue({ data: mockMenuItems, error: null });
  vendorMenuFromMock.mockImplementation((table: string) => {
    if (table === 'vendor_menu_items') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: menuOrderMock,
            }),
          }),
        }),
      };
    }
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
  });
}

async function flushMenuLoad() {
  await waitFor(() => {
    expect(screen.getByText(/Veg Curry/)).toBeInTheDocument();
  });
}

async function flushAnimationFrames() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

describe('ParchiSheet free-text message scroll stability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMenuFromMock();
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockFetchUserTrust.mockResolvedValue({
      trust_score: 90,
      is_banned: false,
      total_orders: 5,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads vendor menu once on open, not on each keystroke', async () => {
    renderParchi(<ParchiSheet vendor={deliveryVendor} isOpen onClose={() => {}} />);

    await flushMenuLoad();
    expect(menuOrderMock).toHaveBeenCalledTimes(1);

    const input = screen.getByTestId('parchi-message-input');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(menuOrderMock).toHaveBeenCalledTimes(1);
  });

  it('collapses menu on first keystroke and reopens when text is cleared', async () => {
    renderParchi(<ParchiSheet vendor={deliveryVendor} isOpen onClose={() => {}} />);

    await flushMenuLoad();
    expect(screen.getByTestId('parchi-menu-items-panel')).toBeInTheDocument();

    const input = screen.getByTestId('parchi-message-input');
    fireEvent.change(input, { target: { value: 'need rice' } });
    expect(screen.queryByTestId('parchi-menu-items-panel')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('parchi-menu-items-panel')).toBeInTheDocument();
  });

  it('does not reset scroll position while typing in the message textarea', async () => {
    renderParchi(<ParchiSheet vendor={deliveryVendor} isOpen onClose={() => {}} />);

    await flushMenuLoad();
    await flushAnimationFrames();

    const scrollEl = screen.getByTestId('parchi-scroll-container');
    scrollEl.scrollTop = 420;

    const input = screen.getByTestId('parchi-message-input');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });

    await flushAnimationFrames();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(scrollEl.scrollTop).toBe(420);
  });
});
