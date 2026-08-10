import { describe, it, expect } from 'vitest';
import { vendorBinaryTrustTier } from '@/lib/vendorBinaryTrust';
import { deriveBusinessLocationPasses, type BusinessLocationRow } from '@/lib/trustLevel';

describe('AiBridgeSheet Binary Trust GPS Logic', () => {
  it('GPS-verified business data returns green trust tier for TrustWarningBanner', () => {
    // Simulate the GPS fetch result from useEffect that would happen in AiBridgeSheet
    const mockGpsData = {
      gps_match_distance: 20,
      location_accuracy: 10, 
      photo_accuracy: 5,
      verification_status: 'approved' as const
    };

    // Convert to BusinessLocationRow format as done in component
    const businessLocationData: BusinessLocationRow = {
      vendor_id: 'test-vendor',
      category_id: 'cobbler-category',
      gps_match_distance: mockGpsData.gps_match_distance,
      location_accuracy: mockGpsData.location_accuracy,
      photo_accuracy: mockGpsData.photo_accuracy,
      verification_status: mockGpsData.verification_status,
    };

    const { gps: businessGpsVerified } = deriveBusinessLocationPasses(businessLocationData);
    expect(businessGpsVerified).toBe(true);

    // This would be passed to TrustWarningBanner in AiBridgeSheet
    const trustTier = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: businessGpsVerified,
      latitude: 19.0760, // Account-level GPS (should be ignored when businessGpsVerified is present)
    });

    expect(trustTier).toBe('green');
  });

  it('Non-GPS-verified business data returns red trust tier for TrustWarningBanner', () => {
    // Simulate the GPS fetch result for non-verified business
    const mockGpsData = {
      gps_match_distance: null,
      location_accuracy: null,
      photo_accuracy: null,
      verification_status: 'identity_linked' as const
    };

    // Convert to BusinessLocationRow format as done in component
    const businessLocationData: BusinessLocationRow = {
      vendor_id: 'test-vendor',
      category_id: 'carpenter-category',
      gps_match_distance: mockGpsData.gps_match_distance,
      location_accuracy: mockGpsData.location_accuracy,
      photo_accuracy: mockGpsData.photo_accuracy,
      verification_status: mockGpsData.verification_status,
    };

    const { gps: businessGpsVerified } = deriveBusinessLocationPasses(businessLocationData);
    expect(businessGpsVerified).toBe(false);

    // This would be passed to TrustWarningBanner in AiBridgeSheet
    const trustTier = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: businessGpsVerified,
      latitude: 19.0760, // Account-level GPS (should be ignored when businessGpsVerified is present)
    });

    expect(trustTier).toBe('red');
  });

  it('No category context (fallback) uses account-level GPS for backward compatibility', () => {
    // When categoryId is undefined, component does not fetch GPS data and uses account-level latitude
    const trustTierWithAccountGps = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: null, // No business GPS data fetched
      latitude: 19.0760, // Account has GPS
    });

    expect(trustTierWithAccountGps).toBe('green');

    const trustTierWithoutAccountGps = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: null, // No business GPS data fetched
      latitude: null, // Account has no GPS
    });

    expect(trustTierWithoutAccountGps).toBe('red');
  });

  it('Supabase GPS fetch error handling - falls back to account-level GPS', () => {
    // When supabase.from().select().eq().eq().single() returns error or no data
    // Component sets businessGpsVerified to null, falling back to account-level latitude
    const trustTierOnFetchError = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: null, // Set to null on fetch error in component
      latitude: 19.0760, // Falls back to account GPS
    });

    expect(trustTierOnFetchError).toBe('green');
  });
});