/**
 * Decision D1: eligibility is a pluggable gate. Markets are not decided yet;
 * default rule = no US persons, sanctioned countries blocked.
 * Modes: off | attest | geo+attest. The geo check is a TODO hook (needs an edge
 * header such as x-vercel-ip-country) — attestation is enforced client-side now.
 */
export type EligibilityMode = "off" | "attest" | "geo+attest";

export const ELIGIBILITY_MODE: EligibilityMode =
  (process.env.NEXT_PUBLIC_ELIGIBILITY_MODE as EligibilityMode | undefined) ?? "geo+attest";

export const ATTESTATION_TEXT =
  "I am not a US person, I don't live in a sanctioned country, and I'm allowed to hold tokenized stocks where I live.";

const KEY = "gg.eligibility.attested.v1";

export function hasAttested(): boolean {
  if (ELIGIBILITY_MODE === "off") return true;
  try {
    return localStorage.getItem(KEY) === "yes";
  } catch {
    return false;
  }
}

export function recordAttestation() {
  try {
    localStorage.setItem(KEY, "yes");
  } catch {
    /* storage unavailable: user is asked again next visit */
  }
}
