import { describe, it, expect, vi } from 'vitest';
import { vendorBinaryTrustTier } from '@/lib/vendorBinaryTrust';
import { deriveBusinessLocationPasses, type BusinessLocationRow } from '@/lib/trustLevel';

describe('RadarVendorCard Binary Trust GPS Logic', () => {
  it('GPS-verified business returns green trust tier', () => {
    // Business A: GPS-verified
    const businessLocationData: BusinessLocationRow = {
      vendor_id: 'test-vendor',
      category_id: 'cobbler-category',
      shop_photo_url: 'cobbler_shop.jpg',
      verification_status: 'approved',
      gps_match_distance: 20, // Good GPS match
      location_accuracy: 10,
      photo_accuracy: 5,
    };

    const { gps: businessGpsVerified } = deriveBusinessLocationPasses(businessLocationData);
    expect(businessGpsVerified).toBe(true);

    const trustTier = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: businessGpsVerified,
      latitude: 19.0760, // Account-level GPS (should be ignored when businessGpsVerified is present)
    });

    expect(trustTier).toBe('green');
  });

  it('Non-GPS-verified business returns red trust tier', () => {
    // Business B: No GPS verification
    const businessLocationData: BusinessLocationRow = {
      vendor_id: 'test-vendor',
      category_id: 'carpenter-category',
      shop_photo_url: 'carpenter_shop.jpg',
      verification_status: 'identity_linked',
      gps_match_distance: null, // No GPS verification
      location_accuracy: null,
      photo_accuracy: null,
    };

    const { gps: businessGpsVerified } = deriveBusinessLocationPasses(businessLocationData);
    expect(businessGpsVerified).toBe(false);

    const trustTier = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: businessGpsVerified,
      latitude: 19.0760, // Account-level GPS (should be ignored when businessGpsVerified is present)
    });

    expect(trustTier).toBe('red');
  });

  it('Single-category vendor (baseline) behaves identically to before - using account-level GPS fallback', () => {
    // When no businessGpsVerified is provided, should fall back to account-level latitude
    const trustTierWithGps = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: undefined, // No per-business GPS data
      latitude: 19.0760, // Account has GPS
    });

    expect(trustTierWithGps).toBe('green');

    const trustTierWithoutGps = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: undefined, // No per-business GPS data
      latitude: null, // Account has no GPS
    });

    expect(trustTierWithoutGps).toBe('red');
  });

  it('Per-business GPS overrides account-level GPS (the fix)', () => {
    // Account has GPS but business doesn't - should be red (fixed behavior)
    const trustTier1 = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: false, // Business has no GPS
      latitude: 19.0760, // Account has GPS (should be ignored)
    });
    expect(trustTier1).toBe('red');

    // Account has no GPS but business does - should be green (fixed behavior)
    const trustTier2 = vendorBinaryTrustTier({
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'selfie.jpg',
      businessGpsVerified: true, // Business has GPS
      latitude: null, // Account has no GPS (should be ignored)
    });
    expect(trustTier2).toBe('green');
  });

  it('Accent ring CSS class generation logic', () => {
    // Mock the actual logic that generates accent ring classes
    const getAccentRing = (trustTier: 'green' | 'red') => {
      return trustTier === "green"
        ? "ring-brand/50 shadow-[0_0_24px_rgba(34,197,94,0.25)]"
        : "ring-destructive/30";
    };

    // GPS-verified business should get green accent ring
    const greenRing = getAccentRing('green');
    expect(greenRing).toBe("ring-brand/50 shadow-[0_0_24px_rgba(34,197,94,0.25)]");

    // Non-GPS-verified business should get red accent ring
    const redRing = getAccentRing('red');
    expect(redRing).toBe("ring-destructive/30");
  });
});