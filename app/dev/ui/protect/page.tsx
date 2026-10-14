"use client";

import { notFound } from "next/navigation";
import { ProtectSettings } from "@/components/gg/agents/ProtectSettings";
import { RequireAccount } from "@/components/wallet/RequireAccount";

/** Dev-only: Protect's settings body on a real account (`?as=0x…`), as the agent sheet's slot holds it. A 404 in production. */
export default function DevProtectPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <RequireAccount>
      {(account) => (
        <div className="flex min-h-dvh flex-col gap-3 bg-ground px-5 pb-[34px] pt-[54px]">
          <h1 className="m-0 text-[20px] font-semibold text-ink">Protect</h1>
          <ProtectSettings account={account} />
        </div>
      )}
    </RequireAccount>
  );
}
