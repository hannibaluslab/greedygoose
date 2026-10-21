/** The Leaderboard tab's words. */
export const BOARD_COPY = {
  soon: "The leaderboard opens soon.",
  soonLine: "Everyone joins with their first move. It ranks return since joining, in percent.",
  error: "Couldn’t load the board",
  errorLine: "Base didn’t answer, so nothing is shown.",
  contactsError: "Couldn’t load your contacts",
  contactsErrorLine: "Base didn’t answer. The board is still on All.",
  empty: "Nobody’s on the board yet.",
  emptyLine: "You join with your first move in GreedyGoo.",
  noContacts: "No contacts yet.",
  noContactsLine: "Add people from All, or by name.",
  notRanked: "Not ranked yet",
  // No dollar figure on the board.
  notRankedLine: "Ranked once they’ve put money in.",
  notRankedYou: "Ranked once you’ve put money in.",
  offBoard: "Not on the board yet",
  offBoardLine: "Joins with their first move in GreedyGoo.",
  foot: "Return since joining, in percent. Money added or taken out doesn’t count as a gain.",
  contactsFoot: "Contacts are saved on-chain, under your name.",
  notOnBase: "This name only gives an Ethereum address. Add it if it’s the same account on Base.",
  // Heroes | Wall of shame (Adrian, 2026-10-21), and who Heroes shows.
  heroes: "Heroes",
  wall: "Wall of shame",
  everyone: "Everyone",
  contacts: "Contacts",
  // Add contact (Adrian, 2026-10-21): one sheet to tick people from the board or find them by name.
  addContact: "Add contact",
  addContactTitle: "Add contacts",
  addContactLine: "Tick people on the board, or find them by name.",
  addNoMatch: "Nobody on the board matches. Tap Find to look the name up.",
  addNobody: "Everyone on the board is in your contacts. Find someone by name.",
  // Greedy Fatalities: never "liquidated" on screen.
  wallTitle: "Greedy Fatalities",
  wallLine: "Part of their stock was sold to pay what they owe. Boldest first.",
  wallEmpty: "Nobody’s on the Wall yet.",
  wallEmptyLine: "A name lands here when part of someone’s stock is sold to pay what they owe.",
  wallError: "Couldn’t load the Wall",
  wallFoot: "Ranked by leverage when it happened: what they held, divided by their own money.",
  // Nothing of their own was left at the sale: no multiple to show.
  wipedOut: "Wiped out",
  // The tick a move into Act asks for (SPEC › Credit health): the Wall's rule, stated before the credit.
  wallTick:
    "I understand this puts my credit in Act. If my stocks fall too far and part of them is sold to pay what I owe, my name goes on Greedy Fatalities.",
} as const;
