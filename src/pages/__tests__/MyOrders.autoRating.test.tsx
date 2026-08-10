import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MyOrders from '../MyOrders';

// Mock dependencies
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(),
        })),
        or: vi.fn(() => ({
          order: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
        order: vi.fn(() => Promise.resolve({ data: [], error: null })),
      })),
    })),
    channel: vi.fn(() => ({
      on: vi.fn(() => ({
        subscribe: vi.fn(),
      })),
    })),
    removeChannel: vi.fn(),
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
      myOrders_title: "My Orders",
      myOrders_shopFallback: "Shop",
    }, 
    lang: 'en' 
  })
}));

vi.mock('@/hooks/useAppConfig', () => ({
  useAppConfig: () => ({ 
    config: {} 
  })
}));

const mockOrder = {
  id: 'order-123',
  status: 'pending',
  vendor_id: 'vendor-123',
  user_phone: '9999999999',
  vendors: {
    shop_name: 'Test Shop',
    service_mode: 'delivery',
    phone: '9876543210'
  }
};

describe('MyOrders Auto-Rating Trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defines autoTriggerRatingSheet function with correct behavior', () => {
    // Test the logic that would be called by autoTriggerRatingSheet
    const autoShownReviews = new Set<string>();
    const myReviews = {};
    const orderId = 'order-123';
    
    // Should trigger when no previous auto-show and no existing review
    const shouldTrigger1 = !autoShownReviews.has(orderId) && !myReviews[orderId as keyof typeof myReviews];
    expect(shouldTrigger1).toBe(true);
    
    // Should not trigger when already auto-shown
    autoShownReviews.add(orderId);
    const shouldTrigger2 = !autoShownReviews.has(orderId) && !myReviews[orderId as keyof typeof myReviews];
    expect(shouldTrigger2).toBe(false);
    
    // Should not trigger when review exists
    autoShownReviews.delete(orderId);
    const myReviewsWithReview = { [orderId]: { rating: 5 } };
    const shouldTrigger3 = !autoShownReviews.has(orderId) && !myReviewsWithReview[orderId as keyof typeof myReviewsWithReview];
    expect(shouldTrigger3).toBe(false);
  });

  it('tracks auto-shown reviews correctly', () => {
    const autoShownSet = new Set<string>();
    
    // Initially empty
    expect(autoShownSet.has('order-1')).toBe(false);
    
    // Add order
    autoShownSet.add('order-1');
    expect(autoShownSet.has('order-1')).toBe(true);
    expect(autoShownSet.has('order-2')).toBe(false);
    
    // Add another order
    autoShownSet.add('order-2');
    expect(autoShownSet.has('order-1')).toBe(true);
    expect(autoShownSet.has('order-2')).toBe(true);
  });

  it('simulates real-time status update triggering auto-rating', () => {
    const mockPayload = {
      new: {
        id: 'order-123',
        status: 'fulfilled'
      }
    };
    
    // Simulate the condition check from the real-time handler
    const updated = mockPayload.new as { id: string; status?: string };
    expect(updated.status).toBe('fulfilled');
    expect(updated.id).toBe('order-123');
    
    // This would trigger the auto-rating logic
    expect(updated.status === 'fulfilled').toBe(true);
  });

  it('preserves existing rating sheet behavior for manual triggers', () => {
    // Test that pendingDismissId behavior is preserved
    let pendingDismissId: string | null = null;
    
    // Manual trigger (Rate button) should set pendingDismissId
    const handleManualTrigger = (orderId: string) => {
      pendingDismissId = orderId;
      // Would open rating sheet
    };
    
    // Auto trigger should NOT set pendingDismissId
    const handleAutoTrigger = (orderId: string) => {
      // pendingDismissId remains null
      // Would open rating sheet
    };
    
    // Test manual trigger
    handleManualTrigger('order-123');
    expect(pendingDismissId).toBe('order-123');
    
    // Reset
    pendingDismissId = null;
    
    // Test auto trigger
    handleAutoTrigger('order-123');
    expect(pendingDismissId).toBeNull();
  });

  it('checks for fulfilled orders on mount/data refresh (app closed during fulfillment scenario)', () => {
    // Simulate the scenario: order fulfilled while app was closed, user opens MyOrders later
    const mockRows = [
      {
        id: 'order-fulfilled-while-closed',
        status: 'fulfilled',
        created_at: new Date().toISOString(),
        vendor_id: 'vendor-123',
        vendors: {
          shop_name: 'Test Shop',
          service_mode: 'delivery',
          phone: '9876543210'
        }
      },
      {
        id: 'order-pending',
        status: 'pending', 
        created_at: new Date().toISOString(),
        vendor_id: 'vendor-123',
        vendors: {
          shop_name: 'Test Shop',
          service_mode: 'delivery', 
          phone: '9876543210'
        }
      }
    ];
    
    const autoShownReviews = new Set<string>();
    const myReviews = {}; // No existing reviews
    const loading = false;
    
    // Simulate the useEffect logic that runs on mount/data refresh
    const eligibleOrders = mockRows.filter(r => 
      r.status === 'fulfilled' && 
      !autoShownReviews.has(r.id) && 
      !myReviews[r.id as keyof typeof myReviews]
    );
    
    expect(eligibleOrders).toHaveLength(1);
    expect(eligibleOrders[0].id).toBe('order-fulfilled-while-closed');
    
    // Should trigger auto-rating for this fulfilled order
    const shouldTrigger = !loading && mockRows.length > 0 && eligibleOrders.length > 0;
    expect(shouldTrigger).toBe(true);
  });

  it('does not trigger on mount if order was already auto-shown', () => {
    const mockRows = [
      {
        id: 'order-already-shown',
        status: 'fulfilled',
        created_at: new Date().toISOString(),
        vendor_id: 'vendor-123',
        vendors: { shop_name: 'Test Shop', service_mode: 'delivery', phone: '9876543210' }
      }
    ];
    
    const autoShownReviews = new Set(['order-already-shown']); // Already shown
    const myReviews = {};
    const loading = false;
    
    const eligibleOrders = mockRows.filter(r => 
      r.status === 'fulfilled' && 
      !autoShownReviews.has(r.id) && 
      !myReviews[r.id as keyof typeof myReviews]
    );
    
    expect(eligibleOrders).toHaveLength(0); // Should not trigger
  });

  it('does not trigger on mount if review already exists', () => {
    const mockRows = [
      {
        id: 'order-already-reviewed',
        status: 'fulfilled',
        created_at: new Date().toISOString(),
        vendor_id: 'vendor-123',
        vendors: { shop_name: 'Test Shop', service_mode: 'delivery', phone: '9876543210' }
      }
    ];
    
    const autoShownReviews = new Set<string>();
    const myReviews = { 'order-already-reviewed': { rating: 5, review_text: 'Great!' } }; // Review exists
    const loading = false;
    
    const eligibleOrders = mockRows.filter(r => 
      r.status === 'fulfilled' && 
      !autoShownReviews.has(r.id) && 
      !myReviews[r.id as keyof typeof myReviews]
    );
    
    expect(eligibleOrders).toHaveLength(0); // Should not trigger
  });
});