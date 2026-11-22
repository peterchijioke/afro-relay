import { describe, expect, it } from "vitest";
import { normalizePhone } from "../src/phone.js";

describe("normalizePhone", () => {
  it("normalizes Nigerian local numbers and detects MTN", () => {
    const phone = normalizePhone("0803 123 4567");
    expect(phone).toEqual({
      e164: "+2348031234567",
      bare: "2348031234567",
      country: "NG",
      telco: "MTN",
    });
  });

  it("normalizes +234 numbers and detects Airtel, Glo, 9mobile", () => {
    expect(normalizePhone("+234-802-111-2222").telco).toBe("AIRTEL");
    expect(normalizePhone("2348051112222").telco).toBe("GLO");
    expect(normalizePhone("08091112222").telco).toBe("9MOBILE");
  });

  it("normalizes Kenyan and Ghanaian numbers", () => {
    expect(normalizePhone("0722123456", "KE")).toEqual({
      e164: "+254722123456",
      bare: "254722123456",
      country: "KE",
      telco: "SAFARICOM",
    });

    expect(normalizePhone("0241234567", "GH")).toEqual({
      e164: "+233241234567",
      bare: "233241234567",
      country: "GH",
      telco: "MTN",
    });
  });

  it("throws on invalid phone numbers", () => {
    expect(() => normalizePhone("12345")).toThrow();
    expect(() => normalizePhone("08031234")).toThrow();
  });
});
