import Link from "next/link";
import type { ReactNode } from "react";
import { WhiteCard } from "@/components/gg/Screen";
import { StatusPill } from "@/components/gg/Status";
import { GooseMark } from "@/components/gg/kit/GooseMark";
import { StockAvatar } from "@/components/gg/kit/StockAvatar";
import {
  ActivityIcon,
  AgentsIcon,
  BoardIcon,
  ChevronRight,
  CreditIcon,
  GearIcon,
  HomeIcon,
  InvestIcon,
  MarketIcon,
  MenuIcon,
  PlusIcon,
  RepayIcon,
  SaveIcon,
  SendIcon,
  ShieldIcon,
  TradeIcon,
  TrendUpIcon,
} from "@/components/gg/kit/icons";
import { EQUITIES } from "@/lib/tokens/registry";
import type { Guide, GuideIcon, GuideTag, GuideTask } from "@/lib/guide/content";

const ICON: Record<GuideIcon, ReactNode> = {
  topup: <PlusIcon size={18} />,
  earn: <SaveIcon size={18} />,
  market: <MarketIcon size={18} />,
  sell: <InvestIcon size={18} />,
  trade: <TradeIcon size={18} />,
  credit: <CreditIcon size={18} />,
  repay: <RepayIcon size={18} />,
  status: <ShieldIcon size={16} />,
  earnStocks: <SaveIcon size={18} />,
  send: <SendIcon size={18} />,
  agents: <AgentsIcon size={18} />,
  activity: <ActivityIcon size={18} />,
  board: <BoardIcon size={18} />,
  // A falling line: the trend icon, flipped.
  fatalities: <TrendUpIcon size={18} className="-scale-y-100" />,
  settings: <GearIcon size={18} />,
};

/** Each place's mark: the tab bar's own icons, and the menu's. */
const PLACE_ICON: Record<string, ReactNode> = {
  Home: <HomeIcon size={17} />,
  Invest: <InvestIcon size={17} />,
  Agents: <AgentsIcon size={17} />,
  Leaderboard: <BoardIcon size={17} />,
  Send: <SendIcon size={17} />,
  Menu: <MenuIcon size={17} />,
};

const INTRO_ICON: Record<string, ReactNode> = {
  Cash: <SaveIcon size={18} />,
  Stocks: <InvestIcon size={18} />,
  Credit: <CreditIcon size={18} />,
};

/** The Guide's sections, in reading order: the app in three lines, where things are, the tasks, then the words. */
export function GuideView({ guide }: { guide: Guide }) {
  return (
    <>
      <Intro guide={guide} />

      <Section title="Where things are">
        <WhiteCard className="flex flex-col px-4 py-0.5">
          {guide.places.map((p, i) => (
            <div key={p.name} className={`flex gap-3 py-3 ${i ? "border-t border-hairline" : ""}`}>
              <Chip lime={p.name === "Agents"} size={32}>
                {PLACE_ICON[p.name]}
              </Chip>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[15px] font-semibold">
                  {p.name}
                  {p.tag && <Tag tag={p.tag} />}
                </span>
                <span className="text-[14px] leading-snug text-ink-mid">{p.text}</span>
              </div>
            </div>
          ))}
        </WhiteCard>
      </Section>

      <Section title="I want to" sub="Tap one to see where and how.">
        {guide.groups.map((g) => (
          <div key={g.title} className="flex flex-col gap-2">
            <h3 className="m-0 px-1 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">
              {g.title}
            </h3>
            <WhiteCard className="px-4 py-0.5">
              {g.tasks.map((t, i) => (
                <Task key={t.id} task={t} first={i === 0} />
              ))}
            </WhiteCard>
          </div>
        ))}
      </Section>

      <Section title="Words you’ll see">
        <div className="rounded-[22px] bg-card-bone px-4 py-4">
          <dl className="m-0 flex flex-col gap-2.5">
            {guide.words.map((r) => (
              <div key={r.term} className="grid grid-cols-[104px_1fr] gap-3 text-[14px] leading-snug">
                <dt className="font-semibold">{r.term}</dt>
                <dd className="m-0 text-ink-2">{r.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>
    </>
  );
}

/** The app in three lines, on bone with the goose: cash, stocks (with their logos) and credit. */
function Intro({ guide }: { guide: Guide }) {
  return (
    <div className="flex flex-col gap-4 rounded-[22px] bg-card-bone px-4 py-4">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-[22px] bg-ink">
          <GooseMark className="h-[34px] w-auto" />
        </span>
        <h2 className="m-0 text-[19px] font-semibold leading-tight tracking-[-0.02em]">GreedyGoose in three lines</h2>
      </div>
      <dl className="m-0 flex flex-col gap-3.5">
        {guide.intro.map((r) => (
          <div key={r.term} className="flex gap-3">
            <Chip lime size={36}>
              {INTRO_ICON[r.term]}
            </Chip>
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-[15px] font-semibold leading-tight">{r.term}</dt>
              <dd className="m-0 text-[14px] leading-snug text-ink-2">{r.text}</dd>
              {r.term === "Stocks" && <Logos />}
            </div>
          </div>
        ))}
      </dl>
      <p className="m-0 flex items-center gap-2 border-t border-[rgba(14,13,11,0.1)] pt-3 text-[13px] leading-snug text-ink-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand ring-1 ring-ink/25" />
        {guide.approve}
      </p>
    </div>
  );
}

/** The seven stocks' logos in a row, overlapping, so "four more" has faces. */
function Logos() {
  return (
    <div aria-hidden className="flex pt-0.5">
      {EQUITIES.map((e, i) => (
        <span key={e.symbol} className={`rounded-full ring-2 ring-card-bone ${i ? "-ml-1.5" : ""}`}>
          <StockAvatar symbol={e.symbol} size={24} />
        </span>
      ))}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 pt-2">
      <div className="flex flex-col gap-0.5 px-1">
        <h2 className="m-0 text-lg font-semibold tracking-[-0.015em]">{title}</h2>
        {sub && <p className="m-0 text-[13px] text-ink-mid">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

/** A round icon mark: lime, as the app's own action chips, or quiet. */
function Chip({ lime = false, size, children }: { lime?: boolean; size: number; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full text-ink ${lime ? "bg-brand ring-1 ring-ink/10" : "bg-pill"}`}
      style={{ width: size, height: size }}
    >
      {children}
    </span>
  );
}

function Tag({ tag }: { tag: GuideTag }) {
  return (
    <span className="flex h-5 shrink-0 items-center whitespace-nowrap rounded-[10px] bg-pill px-2 text-[11px] font-semibold text-ink-mid">
      {tag}
    </span>
  );
}

/** One task: a row that opens on tap (no script needed) to its steps, the line to know and a link to the screen. */
function Task({ task, first }: { task: GuideTask; first: boolean }) {
  return (
    <details className={`group ${first ? "" : "border-t border-hairline"}`}>
      <summary className="flex min-h-[64px] cursor-pointer list-none items-center gap-3 py-3 [&::-webkit-details-marker]:hidden">
        <Chip lime size={36}>
          {ICON[task.icon]}
        </Chip>
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="text-[15px] font-semibold leading-tight">{task.title}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Where path={task.where} />
            {task.tag && <Tag tag={task.tag} />}
          </span>
        </span>
        <span aria-hidden className="text-subtle transition-transform group-open:rotate-90">
          <ChevronRight />
        </span>
      </summary>
      <div className="flex flex-col gap-3 pb-4 pl-12">
        {task.steps.length > 0 && (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {task.steps.map((s, i) => (
              <li key={s} className="flex gap-2.5 text-[14px] leading-snug">
                <span
                  aria-hidden
                  className="num mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-ink ring-1 ring-ink/15"
                >
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        )}
        {task.statuses && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {task.statuses.map((s) => (
              <li key={s.status} className="grid grid-cols-[64px_1fr] items-start gap-2.5 text-[14px] leading-snug">
                <span className="pt-px">
                  <StatusPill status={s.status} size="row" />
                </span>
                <span>{s.text}</span>
              </li>
            ))}
          </ul>
        )}
        {task.note && <p className="m-0 text-[13px] leading-snug text-ink-mid">{task.note}</p>}
        <Link
          href={task.link.href}
          className="flex h-9 items-center gap-1 self-start rounded-[18px] bg-ink pl-3.5 pr-2.5 text-[13px] font-semibold text-on-ink no-underline"
        >
          {task.link.label} <ChevronRight />
        </Link>
      </div>
    </details>
  );
}

/** Where a task lives, in the app's labels: Home › Top up. */
function Where({ path }: { path: readonly string[] }) {
  return (
    <span className="text-[12.5px] leading-snug text-ink-mid">
      {path.map((p, i) => (
        <span key={p}>
          {i > 0 && <span className="px-1 text-subtle">›</span>}
          {p}
        </span>
      ))}
    </span>
  );
}
