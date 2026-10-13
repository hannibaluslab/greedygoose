"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useConnect } from "wagmi";
import { FaceIdIcon } from "@/components/gg/icons";
import { ATTESTATION_TEXT, ELIGIBILITY_MODE, hasAttested, recordAttestation } from "@/lib/eligibility";

const noopSubscribe = () => () => {};

/** Design board "1 · Welcome" (Main.dc.html). Headline corrected: stocks are collateral-only, they don't earn yield. */
export default function Welcome() {
  const router = useRouter();
  const { status } = useAccount();
  const { connect, connectors, isPending, error, reset } = useConnect();
  const stored = useSyncExternalStore(noopSubscribe, hasAttested, () => false);
  const [ticked, setTicked] = useState(false);
  const attested = stored || ticked;
  const needsAttest = ELIGIBILITY_MODE !== "off";

  useEffect(() => {
    if (status === "connected") router.replace("/home");
  }, [status, router]);

  const start = () => {
    if (needsAttest && !attested) return;
    recordAttestation();
    reset();
    const jaw = connectors.find((c) => c.type === "jaw");
    if (jaw) connect({ connector: jaw });
  };
  const rejected = error && /reject|denied|cancel/i.test(error.message);
  const blocked = isPending || (needsAttest && !attested);

  return (
    <main className="flex min-h-dvh flex-col gap-6 px-5 pb-[34px] pt-16">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex size-8 items-center justify-center rounded-2xl bg-accent text-[15px] font-bold">G</span>
        <span className="text-[17px] font-semibold">GreedyGoose</span>
      </div>

      <div className="flex grow flex-col justify-center gap-4">
        <div className="font-mono text-xs uppercase tracking-[0.08em] text-muted">Stocks · credit · Base</div>
        <h1 className="m-0 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] [text-wrap:pretty]">
          Your stocks stay yours. Borrow against them in one tap.
        </h1>
        <p className="m-0 text-base leading-[1.45] text-muted [text-wrap:pretty]">
          Hold NVIDIA, Apple and more. Use them to borrow dollars when you need cash, without selling anything.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {needsAttest && (
          <label className="flex items-start gap-2.5 px-1 text-[13px] leading-[1.4] text-muted">
            <input
              type="checkbox"
              className="mt-px size-[18px] shrink-0 accent-[#0e0d0b]"
              checked={attested}
              onChange={(e) => setTicked(e.target.checked)}
            />
            {ATTESTATION_TEXT}
          </label>
        )}
        <button
          type="button"
          onClick={start}
          disabled={blocked}
          className="flex h-14 items-center justify-center gap-2.5 rounded-[28px] bg-ink text-base font-semibold text-on-ink disabled:opacity-45"
        >
          <FaceIdIcon />
          {isPending ? "Waiting for Face ID…" : "Create account with Face ID"}
        </button>
        <button
          type="button"
          onClick={start}
          disabled={blocked}
          className="h-14 rounded-[28px] border border-[rgba(14,13,11,0.18)] bg-transparent text-base font-semibold text-ink disabled:opacity-45"
        >
          Sign in with your JAW account
        </button>
        <p className="mt-1 text-center text-[13px] leading-[1.4] text-muted">
          Already hold stocks in a JAW account? Sign in and they show up here. Secured by passkey, built on JAW.
        </p>
        {error && (
          <p role="alert" className="text-center text-[13px] text-act">
            {rejected ? "Sign-in was cancelled. Try again when you’re ready." : "We couldn’t sign you in. Please try again."}
          </p>
        )}
      </div>
    </main>
  );
}
