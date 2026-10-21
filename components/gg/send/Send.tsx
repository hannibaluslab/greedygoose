"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { isAddressEqual, type Address } from "viem";
import { useAccount } from "wagmi";
import { AmountBadge, AmountField, AmountHintLine } from "../kit/AmountField";
import { AssetPicker, assetMark, type PickerRow } from "../kit/AssetPicker";
import { Button } from "../kit/Button";
import { useMoneySheets } from "../cash/MoneySheets";
import { TabHeader } from "../Screen";
import { StockAvatar } from "../kit/StockAvatar";
import { Summary } from "../home/Summary";
import { TabBar } from "../TabBar";
import { TxButton, TxDone, TxError } from "../TxUi";
import { ReceiveIcon } from "../kit/icons";
import { QuickPicks, ToCard } from "./SendTo";
import { useFollowing, useNames } from "@/hooks/useContacts";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import type { PositionData } from "@/hooks/usePosition";
import { useRecipient, useSend } from "@/hooks/useSend";
import { readLocal, subscribeLocal, type LocalActivity } from "@/lib/activity/local";
import {
  SEND_COPY,
  defaultAsset,
  parseTo,
  planSend,
  recentRecipients,
  sendForm,
  sendOptions,
  type SendAction,
  type SendAsset,
  type SendForm,
} from "@/lib/send";

/** 0x and 40 hex characters: an address in full, whatever its capitals. */
const FULL_ADDRESS = /^0x[0-9a-f]{40}$/i;

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
export function SendScreen({ user, data }: { user: Address; data: PositionData }) {
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
    <div className="relative flex min-h-dvh flex-col gap-3 px-5 leading-[normal]">
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

          <Summary rows={view.rows} />
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
