import { describe, expect, it } from "vitest";
import {
  govEmergencyHelpLinesForTerm,
  showGovHelpAlongsideRadiusExpand,
} from "@/lib/categories";

describe("govEmergencyHelpLinesForTerm", () => {
  it("maps fire / medical / roadside / security to keyed helplines", () => {
    expect(govEmergencyHelpLinesForTerm("Fire Brigade")).toBe("fire");
    expect(govEmergencyHelpLinesForTerm("Ambulance")).toBe("medical");
    expect(govEmergencyHelpLinesForTerm("hospital nearby")).toBe("medical");
    expect(govEmergencyHelpLinesForTerm("Mechanic")).toBe("roadside");
    expect(govEmergencyHelpLinesForTerm("Security")).toBe("security");
  });

  it("returns null for unrelated categories (no default 112)", () => {
    expect(govEmergencyHelpLinesForTerm("AC Cooler repair")).toBeNull();
    expect(govEmergencyHelpLinesForTerm("Electrician")).toBeNull();
    expect(govEmergencyHelpLinesForTerm("Beautician")).toBeNull();
    expect(govEmergencyHelpLinesForTerm("shoe repair")).toBeNull();
    expect(showGovHelpAlongsideRadiusExpand("AC Cooler repair")).toBe(false);
  });
});
