"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { isAddressEqual, type Address } from "viem";
import { useAccount } from "wagmi";
import { AmountBadge, AmountField, AmountHintLine } from "./AmountField";
import { AssetPicker, assetMark, type PickerRow } from "./AssetPicker";
import { Button } from "./Button";
import { Initial } from "./Initial";
import { useMoneySheets } from "./MoneySheets";
import { TabHeader } from "./Screen";
import { StockAvatar } from "./StockAvatar";
import { NETWORK_FEE_ROW, Summary } from "./Summary";
import { TabBar } from "./TabBar";
import { TxButton, TxDone, TxError } from "./TxUi";
import { CloseIcon, ReceiveIcon } from "./icons";
import { useFollowing, useNames } from "@/hooks/useContacts";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { useWithBackingFactors, type PositionData } from "@/hooks/usePosition";
import { useRecipient, useSend, type ToState } from "@/hooks/useSend";
import { readLocal, subscribeLocal, type LocalActivity } from "@/lib/activity/local";
import { shortAddress } from "@/lib/formatting";
import {
  SEND_COPY,
  defaultAsset,
  parseTo,
  planSend,
  recentRecipients,
  sendForm,
  sendOptions,
  type Recipient,
  type SendAction,
  type SendAsset,
  type SendForm,
} from "@/lib/send";

/** 0x and 40 hex characters: an address in full, whatever its capitals. */
const FULL_ADDRESS = /^0x[0-9a-f]{40}$/i;

/** "0x2b8c e2c8 7c16 …": the whole address in fours, so a look-alike that shares its ends can't pass for it. */
const grouped = (a: string) => `0x${a.slice(2).match(/.{4}/g)!.join(" ")}`;

/** How many contacts the quick picks show: one swipe's worth. */
const CONTACT_PICKS = 8;

const pickerRows = (data: PositionData): PickerRow[] =>
  sendOptions(data).map((o) => ({
    id: o.asset,
    name: o.name,
    mark: assetMark(o.asset, 32),
    sub: o.sub,
    right: o.right,
    rightSub: o.rightSub,
    disabled: o.disabled,
  }));

const EMPTY = "[]";

/** This device's own records of what it sent, for the Recent quick picks (lib/activity/local.ts). */
function useLocalActivity(user: Address): LocalActivity[] {
  const snap = useSyncExternalStore(
    subscribeLocal,
    () => JSON.stringify(readLocal(user)),
    () => EMPTY,
  );
  return useMemo(() => (snap === EMPTY ? [] : (JSON.parse(snap) as LocalActivity[])), [snap]);
}

/**
 * The Send tab (Adrian, 2026-10-15: "replace pay by send, and let user send their assets out"). NYM's SendSheet on one
 * screen in the kit: what (Cash or a stock's free shares, NYM's source pill as the Trade sheet's picker), how much in
 * dollars with MAX, to whom (a name or an address, looked up and shown with its address before anything is sent, with
 * Recent and Contacts as quick picks), the summary, the small print and one button that opens JAW's sheet once. No
 * confirm screen of ours. Receive, the address and its QR, is one tap away in the header.
 */
export function SendScreen({ user, data: position }: { user: Address; data: PositionData }) {
  // Each stock's backing factor on its holding: a stock that backs credit sends up to the 1.12 line (Up to $X).
  const data = useWithBackingFactors(position);
  const { isConnected } = useAccount();
  const fee = useFeeSupport();
  const money = useMoneySheets();
  const to = useRecipient();
  const [form, setForm] = useState<SendForm>(() => ({ asset: defaultAsset(data), amount: "", all: false }));
  // Opened with nothing to send: the asset appears once there is something (money arrives while it's open).
  const asset: SendAsset | null = form.asset ?? defaultAsset(data);
  const [menu, setMenu] = useState(false);
  const [text, setText] = useState("");
  const [sentTitle, setSentTitle] = useState<string | null>(null);

  const view = planSend({
    asset,
    amount: form.amount,
    all: form.all,
    data,
    user,
    recipient: to.recipient,
    checks: to.checks,
  });
  const feeBlocked = isConnected && fee.state === "unsupported";
  // What Send would sign now, prepared while the screen is idle (useSend), so the tap opens JAW's sheet straight away.
  const input =
    view.ready && view.token && to.recipient && !feeBlocked
      ? {
          user,
          token: view.token,
          recipient: to.recipient,
          amountRaw: view.amountRaw,
          takeOutRaw: view.takeOutRaw,
          takeOutAll: view.takeOutAll,
        }
      : null;
  const tx = useSend(input);
  const { phase, error, reset, busy, txHash } = tx;

  // The picker's list sits on a page here, not in a sheet, so Escape closing it is ours.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const following = useFollowing(user);
  const contactAddrs = useMemo(() => (following.data?.addresses ?? []).slice(0, CONTACT_PICKS), [following.data]);
  const contactNames = useNames(contactAddrs);
  const recent = recentRecipients(useLocalActivity(user));
  const contacts = contactAddrs
    .filter((a) => !recent.some((r) => isAddressEqual(r.address, a)))
    .map((a) => ({ address: a, name: contactNames.get(a.toLowerCase()) ?? null }));
  // The quick picks' names are labels to pick by. A pick sends to the address alone; the card shows its name only
  // once that name is checked to point back to it (useRecipient), so a name that moved on never sits over an old address.

  const fresh = () => {
    if (phase === "failed") reset();
  };
  const dispatch = (action: SendAction) => {
    fresh();
    setForm((f) => sendForm({ ...f, asset: f.asset ?? asset }, action, data));
  };
  const onText = (value: string) => {
    fresh();
    setText(value);
    // A pasted address is taken at once, or its typo shown at once; anything else waits for Find. Any other edit drops
    // a lookup still running, so what was typed before can't come back as the recipient.
    if (parseTo(value).kind === "address" || FULL_ADDRESS.test(value.trim())) void to.find(value);
    else to.edit();
  };
  const onFind = (e: FormEvent) => {
    e.preventDefault();
    fresh();
    if (text.trim()) void to.find(text);
  };
  const pick = (address: Address) => {
    fresh();
    setText("");
    to.pick(address);
  };
  const change = () => {
    fresh();
    setText("");
    to.clear();
  };

  const sign = () => {
    if (!input) return;
    fresh();
    setSentTitle(view.sentTitle);
    void tx.sign();
  };
  const again = () => {
    reset();
    setSentTitle(null);
    setForm({ asset: defaultAsset(data), amount: "", all: false });
    change();
  };

  const nameOf = (a: SendAsset) =>
    a === "cash" ? SEND_COPY.cashName : (data.holdings.find((h) => h.symbol === a)?.name ?? a);

  return (
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 pt-[calc(env(safe-area-inset-top)+8px)] leading-[normal]">
      <SendHeader />

      {phase === "done" && sentTitle ? (
        <SendDone title={sentTitle} txHash={txHash} onDone={again} />
      ) : !asset ? (
        <div className="flex flex-col items-start gap-3 pt-1">
          <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">{SEND_COPY.emptyTitle}</h2>
          <p className="m-0 text-[14px] leading-[1.4] text-ink-mid">{SEND_COPY.emptyLine}</p>
          <Button variant="dark" onClick={money.topUp} className="mt-1 w-full">
            {SEND_COPY.topUp}
          </Button>
        </div>
      ) : (
        <>
          <AmountField
            label={SEND_COPY.youSend}
            source={
              <AssetPicker
                label={SEND_COPY.pill(nameOf(asset))}
                title={SEND_COPY.menu}
                name={nameOf(asset)}
                mark={assetMark(asset, 18)}
                rows={pickerRows(data)}
                selected={asset}
                open={menu}
                onToggle={() => setMenu((m) => !m)}
                onClose={() => setMenu(false)}
                onPick={(id) => {
                  setMenu(false);
                  dispatch({ type: "pick", asset: id });
                }}
                disabled={busy}
              />
            }
            badge={asset === "cash" ? <AmountBadge kind="cash" /> : <StockAvatar symbol={asset} />}
            value={form.amount}
            onValue={(value) => dispatch({ type: "amount", value })}
            onMax={view.maxUsd > 0 ? () => dispatch({ type: "max" }) : undefined}
            disabled={busy}
            hint={view.hint && <AmountHintLine hint={view.hint} />}
          />
          {view.amountNote && (
            <p role="alert" className="m-0 px-0.5 text-[13px] leading-snug text-act">
              {view.amountNote}
            </p>
          )}

          <ToCard
            state={to.state}
            recipient={to.recipient}
            text={text}
            onText={onText}
            onFind={onFind}
            onChange={change}
            disabled={busy}
            note={view.toNote}
            waiting={view.waiting}
          />

          {!to.recipient && (recent.length > 0 || contacts.length > 0) && (
            <div className="flex flex-col gap-3">
              {recent.length > 0 && (
                <QuickPicks label={SEND_COPY.recent} people={recent} onPick={pick} disabled={busy} />
              )}
              {contacts.length > 0 && (
                <QuickPicks label={SEND_COPY.contacts} people={contacts} onPick={pick} disabled={busy} />
              )}
            </div>
          )}

          <Summary rows={[...view.rows, NETWORK_FEE_ROW]} />
          {view.smallPrint && (
            <p className="m-0 break-words px-0.5 text-[11.5px] leading-[1.45] text-subtle">{view.smallPrint}</p>
          )}
          {feeBlocked && (
            <p role="alert" className="m-0 text-[13px] text-act">
              {SEND_COPY.feeUnsupported}
            </p>
          )}
          <TxError error={error} />
          <div className="mt-1">
            <TxButton
              label={view.button}
              size="md"
              phase={phase}
              checking={tx.checking}
              preview={!isConnected}
              disabled={!input || fee.loading || tx.blocked || phase === "done"}
              onClick={sign}
            />
          </div>
        </>
      )}

      <TabBar />
    </div>
  );
}

/** The tab's title, with Back to Home and Receive (the address and its QR) one tap away, as the Top up sheet over Send. */
export function SendHeader() {
  const money = useMoneySheets();
  return (
    <TabHeader
      title={SEND_COPY.title}
      back="/home"
      action={
        <button
          type="button"
          onClick={money.topUp}
          className="flex h-9 items-center gap-1.5 rounded-[18px] bg-chip pl-2.5 pr-3.5 text-[14px] font-semibold text-ink transition active:scale-[0.97]"
        >
          <ReceiveIcon size={16} />
          {SEND_COPY.receive}
        </button>
      }
    />
  );
}

/** Once the batch lands: "Sent $25.00 to sam.justan.id", the transaction on Base, and Done for a fresh Send. */
export function SendDone({ title, txHash, onDone }: { title: string; txHash?: `0x${string}`; onDone: () => void }) {
  return <TxDone title={title} body={SEND_COPY.sentBody} txHash={txHash} onDone={onDone} doneLabel={SEND_COPY.done} />;
}

/**
 * To, in the amount card's kit: the field and Find (NYM's "Name, handle, or 0x address" with its Use button), or, once
 * someone is picked, who they are with their address under the name and a way to change it. Under it, why there's no one
 * (a typo, a name that points nowhere) or the recipient's guard.
 */
function ToCard({
  state,
  recipient,
  text,
  onText,
  onFind,
  onChange,
  disabled,
  note,
  waiting,
}: {
  state: ToState;
  recipient: Recipient | null;
  text: string;
  onText: (value: string) => void;
  onFind: (e: FormEvent) => void;
  onChange: () => void;
  disabled?: boolean;
  note: { text: string; tone: "act" | "watch" } | null;
  waiting: boolean;
}) {
  const looking = state.kind === "looking";
  const card = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const had = useRef(!!recipient);
  // When the field turns into who it is (Find, a paste, a pick), or back (Send to someone else), the control that had
  // focus is gone and focus would drop to the page: keep it in To, on the card, or back in the field.
  useEffect(() => {
    if (!!recipient === had.current) return;
    had.current = !!recipient;
    const active = document.activeElement;
    if (active && active !== document.body && !card.current?.contains(active)) return;
    (recipient ? card.current : input.current)?.focus();
  }, [recipient]);
  const labelClass = "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle";
  return (
    <div className="flex flex-col gap-2">
      <div
        ref={card}
        role="group"
        aria-labelledby="send-to-label"
        tabIndex={-1}
        className="flex flex-col gap-2 rounded-[16px] border border-line-field bg-card p-3.5 leading-[normal] outline-none focus-within:border-ink focus:border-ink"
      >
        {recipient ? (
          <span id="send-to-label" className={labelClass}>
            {SEND_COPY.to}
          </span>
        ) : (
          <label id="send-to-label" htmlFor="send-to" className={labelClass}>
            {SEND_COPY.to}
          </label>
        )}
        {recipient ? (
          <div className="flex items-center gap-2.5">
            <Initial person={{ account: recipient.address, name: recipient.name }} size={36} />
            {/* A name over its address, shortened; an address without one in full, in fours. */}
            <span className="num flex min-w-0 grow flex-col gap-0.5">
              <span className="truncate text-[16px] font-semibold tracking-[-0.01em]">
                {recipient.name ?? shortAddress(recipient.address)}
              </span>
              <span
                className={`text-[12px] text-ink-mid ${recipient.name ? "truncate" : "break-words leading-[1.35]"}`}
              >
                {recipient.name ? shortAddress(recipient.address) : grouped(recipient.address)}
              </span>
            </span>
            <button
              type="button"
              aria-label={SEND_COPY.change}
              onClick={onChange}
              disabled={disabled}
              className="relative grid size-8 shrink-0 place-items-center rounded-full bg-[rgba(15,14,11,0.06)] text-ink-mid transition after:absolute after:-inset-1.5 after:content-[''] active:scale-95 disabled:opacity-45"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        ) : (
          <form onSubmit={onFind} className="flex items-center gap-2">
            <input
              ref={input}
              id="send-to"
              value={text}
              onChange={(e) => onText(e.target.value)}
              placeholder={SEND_COPY.toPlaceholder}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              disabled={disabled}
              className="h-11 min-w-0 grow bg-transparent text-base text-ink placeholder:text-ink-faint focus:outline-none"
            />
            {text && (
              <button
                type="button"
                aria-label="Clear"
                onClick={() => {
                  onText("");
                  input.current?.focus();
                }}
                className="-mx-1.5 grid size-11 shrink-0 place-items-center rounded-full text-ink-mid"
              >
                <CloseIcon size={14} />
              </button>
            )}
            <button
              type="submit"
              disabled={!text.trim() || looking || disabled}
              className="-mr-1 h-11 shrink-0 rounded-[16px] bg-ink px-4 text-sm font-semibold text-on-ink disabled:opacity-45"
            >
              {looking ? SEND_COPY.looking : SEND_COPY.find}
            </button>
          </form>
        )}
      </div>
      {state.kind === "none" && <Note tone="act">{state.text}</Note>}
      {note && <Note tone={note.tone}>{note.text}</Note>}
      {waiting && (
        <p role="status" className="m-0 px-0.5 text-[13px] leading-snug text-subtle">
          {SEND_COPY.checking}
        </p>
      )}
    </div>
  );
}

/** A refusal is an alert; a warning is a status. */
function Note({ tone, children }: { tone: "act" | "watch"; children: ReactNode }) {
  return (
    <p
      role={tone === "act" ? "alert" : "status"}
      className={`m-0 px-0.5 text-[13px] leading-snug ${tone === "act" ? "text-act" : "text-watch-text"}`}
    >
      {children}
    </p>
  );
}

/** NYM's Recents row: a mono label, then round marks with the name's first label (or the short address), one swipe wide. */
function QuickPicks({
  label,
  people,
  onPick,
  disabled,
}: {
  label: string;
  people: { address: Address; name: string | null }[];
  onPick: (address: Address) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="px-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">{label}</span>
      <div className="-mx-5 flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {people.map((p) => (
          <button
            key={p.address}
            type="button"
            onClick={() => onPick(p.address)}
            disabled={disabled}
            aria-label={`Send to ${p.name ?? p.address}`}
            className="flex w-[72px] shrink-0 flex-col items-center gap-1.5 rounded-[14px] py-1 transition active:scale-95 disabled:opacity-45"
          >
            <Initial person={{ account: p.address, name: p.name }} size={44} />
            <span className="w-full truncate text-center text-[12px] text-ink-mid">
              {p.name ? p.name.split(".")[0] : `${p.address.slice(0, 4)}…${p.address.slice(-4)}`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
