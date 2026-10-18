import { StatusChange, StatusMoveBar, StatusPill } from "@/components/gg/Status";
import { WhiteCard } from "@/components/gg/Screen";
import type { PositionData } from "@/hooks/usePosition";
import { formatUsdTrim, monthlyCostText } from "@/lib/formatting";
import { STATUS_LABEL, type Status } from "@/lib/risk/status";

/** What's owed, rounded up: to the cent under $1,000, to the dollar above, never shown as less than it is. */
const owedText = (usd: number) =>
  formatUsdTrim(Math.max(0, usd < 1000 ? Math.ceil(usd * 100 - 1e-6) / 100 : Math.ceil(usd)));

/**
 * "You owe" (canvas boards 1–8): the amount with its status, which turns into "now → after" once the repay or a
 * free-up changes it; the bar with a hollow marker where the credit is now and a solid one, labelled After, where it
 * lands; then the cost and the credit available, "$243 → $443".
 */
export function OweCard({
  data,
  after,
  creditAfterUsd,
}: {
  data: PositionData;
  /** Where the credit lands, once something on the sheet changes it; null leaves the card as it is now. */
  after: { status: Status; healthFactor: number | null } | null;
  creditAfterUsd: number | null;
}) {
  const creditNow = Math.floor(data.availableUsd);
  return (
    <WhiteCard className="flex flex-col gap-2.5 px-4 py-3 leading-[normal]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14px] font-medium text-ink-mid">You owe</span>
        {after && after.status !== data.status ? (
          <StatusChange from={data.status} to={after.status} />
        ) : (
          <StatusPill status={data.status} size="sm" />
        )}
      </div>
      <span className="num -mt-0.5 text-[36px] font-semibold leading-none tracking-[-0.04em]">
        {owedText(data.debtUsd)}
      </span>
      <StatusMoveBar
        now={data.healthFactor}
        after={after ? after.healthFactor : undefined}
        label={
          after
            ? `Now ${STATUS_LABEL[data.status]}, after this ${STATUS_LABEL[after.status]}`
            : STATUS_LABEL[data.status]
        }
        className={after ? "mt-4" : "mt-1"}
      />
      <div className="num grid grid-cols-2 border-t border-line-field pt-2 text-[12.5px]">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-ink-mid">Cost</span>
          <span className="truncate font-semibold">
            {(data.apr * 100).toFixed(1)}% · {monthlyCostText(data.monthlyCostUsd)}
          </span>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 border-l border-line-field pl-3">
          <span className="text-ink-mid">Credit available</span>
          <span className="truncate font-semibold">
            {formatUsdTrim(creditNow)}
            {creditAfterUsd !== null && creditAfterUsd !== creditNow && (
              <>
                {" "}
                <span aria-hidden className="font-[system-ui] font-normal text-ink-mid">
                  →
                </span>
                <span className="sr-only">after this</span> {formatUsdTrim(creditAfterUsd)}
              </>
            )}
          </span>
        </span>
      </div>
    </WhiteCard>
  );
}
