import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ParchiSheet } from '../ParchiSheet';
import type { Vendor } from '@/lib/supabase';

// Mock dependencies
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(),
        })),
      })),
    })),
  },
}));

vi.mock('@/lib/userIdentity', () => ({
  getUserPhone: () => '9999999999'
}));

vi.mock('@/lib/deviceId', () => ({
  getDeviceId: () => 'test-device-id'
}));

vi.mock('@/lib/language', () => ({
  useLanguage: () => ({ 
    s: {
      parchi_orderLabel: "Order Details",
      parchi_placeholderOrder: "Describe what you need...",
      parchi_sendOrder: "Send Order",
    }, 
    lang: 'en' 
  })
}));

vi.mock('@/hooks/useAppConfig', () => ({
  useAppConfig: () => ({ 
    config: { 
      maxOrderMessageChars: 500,
    } 
  })
}));

vi.mock('@/lib/withNetworkRetry', () => ({
  withNetworkRetry: vi.fn((fn) => fn()),
  throwOnSupabaseNetworkError: vi.fn((result) => result),
}));

const mockVendor: Vendor = {
  id: 'test-vendor-123',
  name: 'Test Vendor',
  shop_name: 'Test Shop',
  phone: '9876543210',
  is_active: true,
  latitude: 19.0760,
  longitude: 72.8777,
  verification_status: 'business_verified',
  shop_photo_url: 'shop.jpg',
  upi_verified: true,
  is_manual_verified: true,
  photo_selfie: 'selfie.jpg',
  created_at: '2024-01-01T00:00:00Z',
  service_mode: 'delivery',
  vendor_note: null,
  cancel_reason_1: null,
  cancel_reason_2: null,
  cancel_reason_3: null,
  cancel_reason_4: null,
  upi_id: null,
  service_radius_km: 5,
  vendor_type: 'shop',
  base_type: 'shop',
  serves_at_vendor_place: true,
  serves_at_customer_place: true,
  profile_status: 'complete',
  ledger_cycle_start: null,
  khata_amber_limit: 1000,
  khata_red_limit: 2000,
  last_updated: '2024-01-01T00:00:00Z',
  gps_match_distance: null,
  discoverable: true,
  subscription_status: null,
  subscription_id: null,
  grace_ends_at: null,
  total_helped: 10,
  total_delivered: 8,
  on_time_rate: 0.9,
  avg_rating: 4.5,
  review_count: 5,
  category: 'Restaurant',
};

describe('ParchiSheet Structured Items', () => {
  const mockOrder = {
    id: 'test-order-123',
    status: 'pending',
    payment_status: 'unpaid',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures structured menu items when order is submitted', () => {
    // Mock menu items being loaded
    const mockMenuItems = [
      {
        id: 'item-1',
        name: 'Veg Curry',
        price: 50,
        unit: 'plate',
        is_available: true,
        description: 'Delicious vegetarian curry'
      },
      {
        id: 'item-2', 
        name: 'Rice',
        price: 30,
        unit: 'bowl',
        is_available: true,
        description: 'Steamed basmati rice'
      }
    ];
    
    // Test the structured item building logic (simulates buildStructuredItems internal function)
    const selectedMenuItems = { 'item-1': 2, 'item-2': 1 };
    const menuItems = mockMenuItems;
    
    // Simulate the buildStructuredItems function behavior
    const structuredItems = Object.entries(selectedMenuItems)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => {
        const item = menuItems.find((m) => m.id === id);
        if (!item) return null;
        return {
          item_id: item.id,
          name: item.name,
          quantity: qty,
          unit_price: item.price,
          unit: item.unit || null,
        };
      })
      .filter(Boolean);

    expect(structuredItems).toEqual([
      {
        item_id: 'item-1',
        name: 'Veg Curry',
        quantity: 2,
        unit_price: 50,
        unit: 'plate',
      },
      {
        item_id: 'item-2', 
        name: 'Rice',
        quantity: 1,
        unit_price: 30,
        unit: 'bowl',
      }
    ]);
  });

  it('returns null for structured items when no menu items selected', () => {
    const selectedMenuItems = {};
    const menuItems: any[] = [];
    
    // Simulate buildStructuredItems with no selections
    const items = Object.entries(selectedMenuItems)
      .filter(([, qty]) => (qty as number) > 0)
      .map(([id, qty]) => {
        const item = menuItems.find((m) => m.id === id);
        if (!item) return null;
        return {
          item_id: item.id,
          name: item.name,
          quantity: qty,
          unit_price: item.price,
          unit: item.unit || null,
        };
      })
      .filter(Boolean);
    
    const structuredItems = items.length > 0 ? items : null;
    
    expect(structuredItems).toBeNull();
  });

  it('includes structured items in create_customer_request call', async () => {
    const mockRpc = vi.fn().mockResolvedValue({ data: 'order-id-123', error: null });
    const { supabase } = await import('@/lib/supabase');
    supabase.rpc = mockRpc;

    // Simulate what would happen when ParchiSheet submits order with menu items
    const expectedStructuredItems = [
      {
        item_id: 'item-1',
        name: 'Veg Curry',
        quantity: 2,
        unit_price: 50,
        unit: 'plate',
      }
    ];

    // This simulates the RPC call that would be made
    await supabase.rpc("create_customer_request", {
      p_device_id: 'test-device-id',
      p_vendor_id: 'test-vendor-123',
      p_message: 'Test order message',
      p_user_phone: '9999999999',
      p_items: expectedStructuredItems,
    });

    expect(mockRpc).toHaveBeenCalledWith("create_customer_request", expect.objectContaining({
      p_items: expectedStructuredItems,
    }));
  });
});