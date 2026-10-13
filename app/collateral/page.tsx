import { redirect } from "next/navigation";

/** Locking collateral and borrowing are one screen now: "Get a loan". */
export default function CollateralRedirect() {
  redirect("/loan");
}
