import type { KeyboardEvent } from "react";

/** iOS's Done/Search/Go key fires Enter but never blurs web inputs, so the
 *  keyboard stays up over the content the user just asked for. Wire this to
 *  `onKeyDown` on inputs whose Enter means "I'm finished typing" (searches,
 *  amounts, phone numbers) so the return key actually dismisses the keyboard. */
export function blurOnEnter(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") e.currentTarget.blur();
}
