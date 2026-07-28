import { describe, expect, it } from "vitest";
import {
  GPS_MATCH_TOLERANCE_M,
  evaluateGpsMatch,
  gpsEffectiveTolerance,
} from "@/lib/gpsMatch";

describe("gpsEffectiveTolerance", () => {
  it("uses 75m floor when accuracies are missing or small", () => {
    expect(gpsEffectiveTolerance(null, null)).toBe(GPS_MATCH_TOLERANCE_M);
    expect(gpsEffectiveTolerance(10, 20)).toBe(GPS_MATCH_TOLERANCE_M);
  });

  it("expands when locationAccuracy + photoAccuracy exceeds the floor", () => {
    expect(gpsEffectiveTolerance(300, 250)).toBe(550);
  });
});

describe("evaluateGpsMatch", () => {
  const shop = { lat: 18.5204, lng: 73.8567, accuracy: 20 };

  it("passes same-spot capture within floor tolerance", () => {
    const photo = { lat: 18.5204, lng: 73.8567, accuracy: 25 };
    const match = evaluateGpsMatch(shop, photo);
    expect(match.ok).toBe(true);
    expect(match.effectiveTolerance).toBe(GPS_MATCH_TOLERANCE_M);
  });

  it("fails ~500m offset with good accuracy (would block under old 75m)", () => {
    // ~511m north
    const photo = { lat: 18.5250, lng: 73.8567, accuracy: 15 };
    const match = evaluateGpsMatch(shop, photo);
    expect(match.distanceMeters).toBeGreaterThan(400);
    expect(match.ok).toBe(false);
  });

  it("passes large offset when poor GPS accuracy widens tolerance", () => {
    const photo = { lat: 18.5213, lng: 73.8567, accuracy: 400 }; // ~100m
    const match = evaluateGpsMatch(
      { ...shop, accuracy: 400 },
      photo,
    );
    expect(match.distanceMeters).toBeGreaterThan(75);
    expect(match.effectiveTolerance).toBe(800);
    expect(match.ok).toBe(true);
  });
});
