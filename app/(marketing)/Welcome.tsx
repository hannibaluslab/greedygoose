"use client";

import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useConnect } from "wagmi";
import { Check } from "lucide-react";
import { Button } from "@/components/gg/Button";
import { GooseMark } from "@/components/gg/GooseMark";
import { CreditIcon, InvestIcon, SaveIcon } from "@/components/gg/icons";
import { useCashRate } from "@/hooks/useCashRate";
import { ATTESTATION_TEXT, ELIGIBILITY_MODE, hasAttested, recordAttestation } from "@/lib/eligibility";
import { SIGN_IN_CONNECTOR_TYPE } from "@/lib/jaw/config";

const noopSubscribe = () => () => {};

/**
 * The welcome before sign-in: the goose, one line, three facts and one Continue. Continue opens JAW's own sign in /
 * sign up frame (the jaw connector, CrossPlatform), so a new account and a returning one take the same tap; once
 * connected, both go Home. Earning is asked there once money is in ("Your $100 arrived · Start earning"), not at $0.
 * Leo's eligibility gate stands: Continue waits for the attestation (D1).
 */
export function Welcome() {
  const router = useRouter();
  const { status, address } = useAccount();
  const { connect, connectors, isPending, error, reset } = useConnect();
  const stored = useSyncExternalStore(noopSubscribe, hasAttested, () => false);
  const [ticked, setTicked] = useState(false);
  const attested = stored || ticked;
  const needsAttest = ELIGIBILITY_MODE !== "off";
  const gated = needsAttest && !attested;
  const apy = useCashRate();

  const connected = status === "connected" && !!address;
  const next = connected ? "/home" : null;

  useEffect(() => {
    if (next) router.replace(next);
  }, [next, router]);

  // The ink body (globals.css). Effects run only while the welcome is shown: once Next hides it after sign-in, the
  // cleanup hands the body back to the ground.
  useLayoutEffect(() => {
    document.body.classList.add("gg-welcome");
    return () => document.body.classList.remove("gg-welcome");
  }, []);

  const start = () => {
    if (gated) return;
    recordAttestation();
    reset();
    const jaw = connectors.find((c) => c.type === SIGN_IN_CONNECTOR_TYPE);
    if (jaw) connect({ connector: jaw });
  };

  // A session JAW restores on load, or the redirect once connected: no second tap.
  const resuming = !isPending && (status === "reconnecting" || status === "connecting" || status === "connected");
  const busy = isPending || resuming;
  const failure = error ? connectFailure(error) : null;

  return (
    <main
      data-welcome
      className="gg-dots-lime relative flex min-h-dvh flex-col px-6 pt-[calc(env(safe-area-inset-top)+16px)] pb-[calc(env(safe-area-inset-bottom)+18px)] text-on-ink"
    >
      <section className="flex grow flex-col items-center justify-center pb-2 pt-4">
        <GooseMark glow className="h-[clamp(124px,30dvh,264px)] w-auto [@media(max-height:700px)]:h-[20dvh]" />
        <p className="m-0 mt-[clamp(10px,2dvh,18px)] text-[19px] font-semibold tracking-[-0.02em]">GreedyGoose</p>
      </section>

      <div className="flex flex-col items-center text-center">
        <h1 className="m-0 max-w-[340px] text-[clamp(34px,5.2dvh,42px)] font-semibold leading-[1.02] tracking-[-0.035em] [text-wrap:balance]">
          Let your money get <span className="text-brand">greedy.</span>
        </h1>
        <p className="m-0 mt-3 text-[15.5px] leading-[1.45] text-ink-on-dark-mute [text-wrap:pretty]">
          Cash, stocks and credit in one account.
        </p>

        <ul className="m-0 mt-[clamp(16px,3dvh,26px)] flex list-none flex-col items-center gap-[clamp(6px,1dvh,8px)] p-0">
          <Fact icon={<SaveIcon size={14} />}>
            {apy == null ? (
              "Cash that earns"
            ) : (
              <>
                Cash earns <span className="num font-semibold text-on-ink">{(apy * 100).toFixed(1)}%</span> APY,
                variable
              </>
            )}
          </Fact>
          <Fact icon={<InvestIcon size={14} />}>Stocks like NVIDIA and Apple</Fact>
          <Fact icon={<CreditIcon size={14} />}>Buy more with credit in one tap</Fact>
        </ul>
      </div>

      <div className="mt-[clamp(18px,3.4dvh,30px)] flex flex-col gap-3">
        {needsAttest && (
          <label className="flex cursor-pointer items-start gap-2.5 px-1 text-left text-[12px] leading-[1.45] text-ink-on-dark-mute">
            <span className="relative mt-px grid size-[18px] shrink-0 place-items-center">
              <input
                type="checkbox"
                className="peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-[5px] border border-[rgba(245,240,226,0.32)] bg-transparent checked:border-brand checked:bg-brand"
                checked={attested}
                onChange={(e) => setTicked(e.target.checked)}
              />
              <Check
                aria-hidden
                size={12}
                strokeWidth={3.5}
                className="pointer-events-none relative text-ink opacity-0 peer-checked:opacity-100"
              />
            </span>
            {ATTESTATION_TEXT}
          </label>
        )}

        {failure && !isPending && (
          <p role="alert" className="m-0 text-center text-[13.5px] leading-[1.4] text-on-ink">
            {failure}
          </p>
        )}

        <Button
          size="lg"
          onClick={start}
          disabled={busy || gated}
          // Waiting on JAW isn't "unavailable": the button keeps its full lime while it spins. Before the attestation
          // it sits dark (a dimmed lime reads as olive on ink) and lights up once ticked.
          className={
            busy
              ? "w-full disabled:opacity-100!"
              : gated
                ? "w-full disabled:bg-pill-dark disabled:text-ink-on-dark-dim disabled:opacity-100!"
                : "w-full"
          }
        >
          {isPending ? (
            <>
              <Spinner />
              Finish in JAW
            </>
          ) : resuming ? (
            <>
              <Spinner />
              Signing you in…
            </>
          ) : failure ? (
            "Try again"
          ) : (
            "Continue"
          )}
        </Button>

        <p className="m-0 text-center text-[12px] leading-[1.4] text-ink-on-dark-dim">
          Secured by JAW.id · passkeys, no seed phrase
        </p>
      </div>
    </main>
  );
}

/** One quiet fact under the headline. */
function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="inline-flex h-[30px] items-center [@media(max-height:700px)]:h-7 gap-2 rounded-full bg-pill-dark pl-2.5 pr-3.5 text-[13px] text-ink-on-dark-soft">
      <span className="text-brand">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

function Spinner() {
  return <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-ink/25 border-t-ink" />;
}

/**
 * JAW rejects with 4001 both when its window is closed and when the browser won't open it
 * ("Failed to open popup. Please allow popups for this site."), so the pop-up case is told apart by its words.
 * A window that never answers ("Timed out waiting for popup message") is a plain failure.
 */
function connectFailure(error: Error): string {
  const words = `${error.name} ${error.message}`;
  if (/failed to open popup|allow pop-?ups/i.test(words))
    return "Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.";
  const code = (error as { code?: unknown }).code;
  if (code === 4001 || /reject|denied|cancel/i.test(words)) return "Sign-in was cancelled.";
  return "We couldn’t sign you in.";
}
