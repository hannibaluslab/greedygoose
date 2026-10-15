/**
 * At most `n` reads in flight at once: the board's reads queue behind each other instead of hitting one RPC all at
 * once, however many members joined (a public node turns a burst away, and one refusal fails the whole board).
 */
export function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= n) return;
    const run = queue.shift();
    if (run) run();
  };
  return function limit<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active += 1;
        job()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
  };
}
