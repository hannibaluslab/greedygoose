/** A round mark with the name's first letter ("0x" without a name): the Leaderboard's people and Send's recipients. */
export function Initial({ person, size = 34 }: { person: { account: string; name: string | null }; size?: number }) {
  const letter = person.name ? person.name.charAt(0).toUpperCase() : "0x";
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full bg-chip font-semibold text-ink"
      style={{ width: size, height: size, fontSize: letter.length > 1 ? size * 0.3 : size * 0.42 }}
    >
      {letter}
    </span>
  );
}
