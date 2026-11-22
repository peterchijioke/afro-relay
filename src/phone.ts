import type { CountryCode, NormalizedPhone, TelcoName } from "./types.js";

const COUNTRY_DIAL_CODES: Record<Exclude<CountryCode, "UNKNOWN">, string> = {
  NG: "234",
  KE: "254",
  GH: "233",
};

const NG_PREFIXES: Record<string, TelcoName> = {
  // MTN Nigeria
  "7025": "MTN",
  "7026": "MTN",
  "703": "MTN",
  "704": "MTN",
  "706": "MTN",
  "803": "MTN",
  "806": "MTN",
  "810": "MTN",
  "813": "MTN",
  "814": "MTN",
  "816": "MTN",
  "903": "MTN",
  "906": "MTN",
  "913": "MTN",
  "916": "MTN",
  // Airtel Nigeria
  "701": "AIRTEL",
  "708": "AIRTEL",
  "802": "AIRTEL",
  "808": "AIRTEL",
  "812": "AIRTEL",
  "901": "AIRTEL",
  "902": "AIRTEL",
  "904": "AIRTEL",
  "907": "AIRTEL",
  "911": "AIRTEL",
  "912": "AIRTEL",
  // Glo Nigeria
  "705": "GLO",
  "805": "GLO",
  "807": "GLO",
  "811": "GLO",
  "815": "GLO",
  "905": "GLO",
  "915": "GLO",
  // 9mobile
  "809": "9MOBILE",
  "817": "9MOBILE",
  "818": "9MOBILE",
  "908": "9MOBILE",
  "909": "9MOBILE",
};

const KE_PREFIXES: Record<string, TelcoName> = {
  "700": "SAFARICOM",
  "701": "SAFARICOM",
  "702": "SAFARICOM",
  "703": "SAFARICOM",
  "704": "SAFARICOM",
  "705": "SAFARICOM",
  "706": "SAFARICOM",
  "707": "SAFARICOM",
  "708": "SAFARICOM",
  "709": "SAFARICOM",
  "710": "SAFARICOM",
  "711": "SAFARICOM",
  "712": "SAFARICOM",
  "713": "SAFARICOM",
  "714": "SAFARICOM",
  "715": "SAFARICOM",
  "716": "SAFARICOM",
  "717": "SAFARICOM",
  "718": "SAFARICOM",
  "719": "SAFARICOM",
  "720": "SAFARICOM",
  "721": "SAFARICOM",
  "722": "SAFARICOM",
  "723": "SAFARICOM",
  "724": "SAFARICOM",
  "725": "SAFARICOM",
  "726": "SAFARICOM",
  "727": "SAFARICOM",
  "728": "SAFARICOM",
  "729": "SAFARICOM",
  "740": "SAFARICOM",
  "741": "SAFARICOM",
  "742": "SAFARICOM",
  "743": "SAFARICOM",
  "745": "SAFARICOM",
  "746": "SAFARICOM",
  "748": "SAFARICOM",
  "757": "SAFARICOM",
  "758": "SAFARICOM",
  "759": "SAFARICOM",
  "768": "SAFARICOM",
  "769": "SAFARICOM",
  "790": "SAFARICOM",
  "791": "SAFARICOM",
  "792": "SAFARICOM",
  "793": "SAFARICOM",
  "794": "SAFARICOM",
  "795": "SAFARICOM",
  "796": "SAFARICOM",
  "797": "SAFARICOM",
  "798": "SAFARICOM",
  "799": "SAFARICOM",
  "110": "SAFARICOM",
  "111": "SAFARICOM",
  "112": "SAFARICOM",
  "113": "SAFARICOM",
  "114": "SAFARICOM",
  "115": "SAFARICOM",
  "730": "AIRTEL",
  "731": "AIRTEL",
  "732": "AIRTEL",
  "733": "AIRTEL",
  "734": "AIRTEL",
  "735": "AIRTEL",
  "736": "AIRTEL",
  "737": "AIRTEL",
  "738": "AIRTEL",
  "739": "AIRTEL",
  "750": "AIRTEL",
  "751": "AIRTEL",
  "752": "AIRTEL",
  "753": "AIRTEL",
  "754": "AIRTEL",
  "755": "AIRTEL",
  "756": "AIRTEL",
  "780": "AIRTEL",
  "781": "AIRTEL",
  "782": "AIRTEL",
  "783": "AIRTEL",
  "784": "AIRTEL",
  "785": "AIRTEL",
  "786": "AIRTEL",
  "787": "AIRTEL",
  "788": "AIRTEL",
  "789": "AIRTEL",
  "100": "AIRTEL",
  "101": "AIRTEL",
  "102": "AIRTEL",
  "770": "TELKOM",
  "771": "TELKOM",
  "772": "TELKOM",
  "773": "TELKOM",
  "774": "TELKOM",
  "775": "TELKOM",
  "776": "TELKOM",
  "777": "TELKOM",
  "778": "TELKOM",
  "779": "TELKOM",
};

const GH_PREFIXES: Record<string, TelcoName> = {
  "24": "MTN",
  "25": "MTN",
  "53": "MTN",
  "54": "MTN",
  "55": "MTN",
  "59": "MTN",
  "20": "TELECEL",
  "50": "TELECEL",
  "26": "AIRTELTIGO",
  "27": "AIRTELTIGO",
  "56": "AIRTELTIGO",
  "57": "AIRTELTIGO",
};

function detectTelco(country: CountryCode, localSignificant: string): TelcoName {
  if (country === "NG") {
    return (
      NG_PREFIXES[localSignificant.slice(0, 4)] ??
      NG_PREFIXES[localSignificant.slice(0, 3)] ??
      "UNKNOWN"
    );
  }
  if (country === "KE") {
    return KE_PREFIXES[localSignificant.slice(0, 3)] ?? "UNKNOWN";
  }
  if (country === "GH") {
    return GH_PREFIXES[localSignificant.slice(0, 2)] ?? "UNKNOWN";
  }
  return "UNKNOWN";
}

/**
 * Normalizes messy African phone inputs ("0803 123 4567", "+234-803-123-4567", "2348031234567")
 * into E.164, bare digits, country code, and detected mobile carrier.
 */
export function normalizePhone(
  raw: string,
  defaultCountry: Exclude<CountryCode, "UNKNOWN"> = "NG",
): NormalizedPhone {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length < 7 || digits.length > 15) {
    throw new Error(`Invalid phone number: "${raw}"`);
  }

  let bare = digits;
  let country: CountryCode = "UNKNOWN";

  if (digits.startsWith("234") && digits.length === 13) {
    country = "NG";
  } else if (digits.startsWith("254") && digits.length === 12) {
    country = "KE";
  } else if (digits.startsWith("233") && digits.length === 12) {
    country = "GH";
  } else if (!hasPlus && digits.startsWith("0")) {
    const dialCode = COUNTRY_DIAL_CODES[defaultCountry];
    bare = `${dialCode}${digits.slice(1)}`;
    country = defaultCountry;
  } else if (!hasPlus && defaultCountry === "NG" && digits.length === 10) {
    bare = `234${digits}`;
    country = "NG";
  } else if (!hasPlus && defaultCountry === "KE" && digits.length === 9) {
    bare = `254${digits}`;
    country = "KE";
  } else if (!hasPlus && defaultCountry === "GH" && digits.length === 9) {
    bare = `233${digits}`;
    country = "GH";
  }

  if (country === "NG" && bare.length !== 13) {
    throw new Error(`Invalid Nigerian phone number length: "${raw}"`);
  }
  if (country === "KE" && bare.length !== 12) {
    throw new Error(`Invalid Kenyan phone number length: "${raw}"`);
  }
  if (country === "GH" && bare.length !== 12) {
    throw new Error(`Invalid Ghanaian phone number length: "${raw}"`);
  }

  const localSignificant =
    country === "UNKNOWN" ? bare : bare.slice(COUNTRY_DIAL_CODES[country].length);

  return {
    e164: `+${bare}`,
    bare,
    country,
    telco: detectTelco(country, localSignificant),
  };
}
