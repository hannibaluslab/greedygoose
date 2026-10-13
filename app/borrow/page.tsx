import { redirect } from "next/navigation";

/** Borrowing lives in "Get a loan", which also handles the no-new-collateral case. */
export default function BorrowRedirect() {
  redirect("/loan");
}
