"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isAddressEqual, type Address } from "viem";
import { useAccount } from "wagmi";
import { toast } from "sonner";
import { AddByNameSheet, type NameLookup } from "./AddByNameSheet";
import { BoardView, PickBar, type BoardState } from "./BoardView";
import { PersonSheet } from "./PersonSheet";
import { useBoard } from "@/hooks/useBoard";
import { useContactsTx, useFollowing, useNames } from "@/hooks/useContacts";
import type { ContactsChange } from "@/lib/tx/plans";
import { TAP_AGAIN } from "@/hooks/useTx";
import { useFeeSupport } from "@/hooks/useFeeSupport";
import { GOOSE_BOARD } from "@/lib/board/config";
import { BOARD_PAGE, type BoardFilter, type BoardPerson, type OffBoard } from "@/lib/board/view";
import { addressOfName } from "@/lib/jaw/name";

const lower = (a: string) => a.toLowerCase();
const FEE_BLOCKED = "Your account can’t pay network fees from your cash right now.";

/**
 * The Leaderboard tab (Adrian, 2026-10-15). Members come from GooseBoard and are scored in this browser from the
 * chain (useBoard); contacts are the account's EFP list on Base (useFollowing). Adding one person, several, or a name,
 * and removing one, each open JAW's own sheet once (useContactsTx), the one in front prepared while the screen is
 * idle. In the dev preview (`?as=`) nothing can be signed.
 */
export function LeaderboardScreen({ address }: { address: Address }) {
  const { address: signer } = useAccount();
  const preview = !signer || !isAddressEqual(signer, address);
  const fee = useFeeSupport();
  const board = useBoard();
  const following = useFollowing(address);

  const [filter, setFilter] = useState<BoardFilter>(
    useSearchParams().get("filter") === "contacts" ? "contacts" : "all",
  );
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // The open sheet keeps its person while it slides away.
  const [person, setPerson] = useState<Address | null>(null);
  const [personShown, setPersonShown] = useState(false);
  const [byName, setByName] = useState(false);
  const [lookup, setLookup] = useState<NameLookup>({ kind: "idle" });
  /** Where the change in JAW's sheet came from, so its result shows there. */
  const [from, setFrom] = useState<"person" | "pick" | "name" | null>(null);
  const [verb, setVerb] = useState<"add" | "remove">("add");

  const rows = useMemo(() => board.data?.rows ?? [], [board.data]);
  const contacts = useMemo(() => following.data?.addresses ?? [], [following.data]);
  const contactSet = useMemo(() => new Set(contacts.map(lower)), [contacts]);
  const memberSet = useMemo(() => new Set(rows.map((r) => lower(r.account))), [rows]);

  // Names for what can be on screen: the first page, you and your contacts (others not ranked yet are only a count).
  const named = useMemo(() => {
    const ranked = rows.filter((r) => r.rank !== null && r.rank <= BOARD_PAGE).map((r) => r.account);
    return [...new Set([address, ...ranked, ...contacts].map(lower))] as Address[];
  }, [rows, contacts, address]);
  const names = useNames(named);
  const nameOf = (a: string) => names.get(lower(a)) ?? null;

  const note = fee.state === "unsupported" && !preview ? FEE_BLOCKED : null;
  const people: BoardPerson[] = rows.map((r) => ({
    account: r.account,
    name: nameOf(r.account),
    pct: r.pct,
    rank: r.rank,
    you: isAddressEqual(r.account, address),
    contact: contactSet.has(lower(r.account)),
  }));
  const offBoard: OffBoard[] = contacts
    .filter((c) => !memberSet.has(lower(c)))
    .map((c) => ({ account: c, name: nameOf(c) }));

  const state: BoardState = !GOOSE_BOARD
    ? { kind: "soon" }
    : (board.isPending && !board.data) || (filter === "contacts" && following.isPending)
      ? { kind: "loading" }
      : !board.data
        ? { kind: "error", what: "board" }
        : filter === "contacts" && !following.data
          ? { kind: "error", what: "contacts" }
          : { kind: "ready", people, offBoard };

  const sheetPerson = person
    ? (people.find((p) => isAddressEqual(p.account, person)) ??
      (contactSet.has(lower(person))
        ? { account: person, name: nameOf(person), contact: true as const, you: false as const }
        : null))
    : null;

  // The change each place would sign now. The one in front (a person's sheet, then the name sheet, then the bar) is
  // prepared while the screen is idle, so its tap opens JAW's sheet at once.
  const personChange: ContactsChange | null =
    personShown && sheetPerson && !sheetPerson.you
      ? { verb: sheetPerson.contact ? "remove" : "add", user: address, targets: [sheetPerson.account] }
      : null;
  const found = lookup.kind === "found" ? lookup : null;
  const nameChange: ContactsChange | null =
    byName && found && !found.you && !found.contact ? { verb: "add", user: address, targets: [found.account] } : null;
  const pickChange: ContactsChange | null =
    picking && picked.size > 0 ? { verb: "add", user: address, targets: [...picked] as Address[] } : null;
  const front = note ? null : (personChange ?? nameChange ?? pickChange);
  const tx = useContactsTx(front);
  const checkingFor = (c: ContactsChange | null) => tx.checking && !!c && c === front;

  // A change that landed closes what asked for it, the sheet or the bar. Derived from the phase rather than set from
  // an effect; `settle` puts it away for good before anything new starts.
  const landed = tx.phase === "done" ? from : null;
  useEffect(() => {
    if (tx.phase === "done") toast.success(verb === "add" ? "Added to your contacts" : "Removed from your contacts");
  }, [tx.phase, verb]);
  // The bar has no room for an error: it comes as a toast.
  useEffect(() => {
    if (from !== "pick" || !tx.error) return;
    if (tx.error === TAP_AGAIN) toast(TAP_AGAIN);
    else if (tx.phase === "failed") toast.error(tx.error);
  }, [from, tx.phase, tx.error]);

  const settle = () => {
    if (landed === "pick") {
      setPicking(false);
      setPicked(new Set());
    }
    if (landed === "person") setPersonShown(false);
    if (landed === "name") setByName(false);
    if (landed) setFrom(null);
    tx.reset();
  };

  const start = (where: "person" | "pick" | "name", v: "add" | "remove") => {
    settle();
    setFrom(where);
    setVerb(v);
  };

  const open = (p: BoardPerson | OffBoard) => {
    if (tx.busy) return;
    settle();
    setPerson(p.account);
    setPersonShown(true);
  };

  const onLookup = async (text: string) => {
    settle();
    setLookup({ kind: "looking" });
    try {
      const found = await addressOfName(text);
      if (!found) return setLookup({ kind: "none", name: text.trim() });
      setLookup({
        kind: "found",
        name: found.name ?? nameOf(found.address),
        account: found.address,
        onBase: found.onBase,
        you: isAddressEqual(found.address, address),
        contact: contactSet.has(lower(found.address)),
        onBoard: memberSet.has(lower(found.address)),
      });
    } catch {
      setLookup({ kind: "none", name: text.trim() });
    }
  };

  return (
    <>
      <BoardView
        filter={filter}
        onFilter={(f) => {
          settle();
          setFilter(f);
          setPicking(false);
          setPicked(new Set());
        }}
        state={state}
        onRetry={() => {
          void board.refetch();
          void following.refetch();
        }}
        picking={picking && landed !== "pick"}
        picked={picked}
        onPickToggle={(a) =>
          setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(lower(a))) next.delete(lower(a));
            else next.add(lower(a));
            return next;
          })
        }
        onPickStart={() => {
          settle();
          setPicked(new Set());
          setPicking(true);
        }}
        onPickStop={() => {
          setPicking(false);
          setPicked(new Set());
        }}
        onOpen={open}
        onAddByName={() => {
          settle();
          setLookup({ kind: "idle" });
          setByName(true);
        }}
        pickBar={
          picking && landed !== "pick" ? (
            <PickBar
              count={picked.size}
              phase={from === "pick" ? tx.phase : "idle"}
              checking={checkingFor(pickChange)}
              // In the dev preview the tap says why nothing can be signed.
              disabled={
                !!note || (tx.busy && from !== "pick") || (pickChange !== null && pickChange === front && tx.blocked)
              }
              onAdd={() => {
                if (preview) return void toast("Preview mode — sign in to do this.");
                if (!pickChange) return;
                start("pick", "add");
                void tx.sign(tx.planOf(pickChange));
              }}
            />
          ) : undefined
        }
      />
      <PersonSheet
        open={personShown && landed !== "person"}
        onClose={() => setPersonShown(false)}
        person={sheetPerson}
        phase={from === "person" ? tx.phase : "idle"}
        checking={checkingFor(personChange)}
        blocked={personChange !== null && personChange === front && tx.blocked}
        error={from === "person" || (personChange !== null && personChange === front) ? tx.error : null}
        note={note}
        preview={preview}
        onAdd={() => {
          if (!personChange) return;
          start("person", "add");
          void tx.sign(tx.planOf(personChange));
        }}
        onRemove={() => {
          if (!personChange) return;
          start("person", "remove");
          void tx.sign(tx.planOf(personChange));
        }}
      />
      <AddByNameSheet
        open={byName && landed !== "name"}
        onClose={() => setByName(false)}
        lookup={lookup}
        onLookup={(t) => void onLookup(t)}
        phase={from === "name" ? tx.phase : "idle"}
        checking={checkingFor(nameChange)}
        blocked={nameChange !== null && nameChange === front && tx.blocked}
        error={from === "name" || (nameChange !== null && nameChange === front) ? tx.error : null}
        note={note}
        preview={preview}
        onAdd={() => {
          if (!nameChange) return;
          start("name", "add");
          void tx.sign(tx.planOf(nameChange));
        }}
      />
    </>
  );
}
