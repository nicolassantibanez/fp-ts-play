import { pipe } from "fp-ts/function";
import * as O from "fp-ts/Option";
import { head } from "fp-ts/ReadonlyArray";

const inverse = (n: number): O.Option<number> =>
  n === 0 ? O.none : O.some(1 / n);

const unsafeHead = (arr: ReadonlyArray<number>): number =>
  pipe(
    arr,
    head,
    O.getOrElse(() => 0)
  );

const inverseHead = (ns: ReadonlyArray<number>) =>
  pipe(
    ns,
    head, // Option<number>
    O.chain(inverse) // Option<number>
  );

const m = O.chain((n: number) => O.some(n));

pipe(
  O.some(5),
  m,
  O.matchW(
    () => console.log("Didn't work"),
    (n) => console.log(`result: ${n}`)
  )
);
