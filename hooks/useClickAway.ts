import { useEffect, useRef } from "react";

/** Fire `onAway` when a mousedown / touchstart lands outside `ref`. Used by
 *  the in-sheet pickers to dismiss their dropdown on an outside tap. The
 *  callback is held in a ref so the document listener isn't re-bound on
 *  every render. */
export function useClickAway(
  ref: React.RefObject<HTMLDivElement | null>,
  onAway: () => void,
) {
  const cbRef = useRef(onAway);
  useEffect(() => {
    cbRef.current = onAway;
  });
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cbRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [ref]);
}
