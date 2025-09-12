import * as E from "fp-ts/Either";
import * as A from "fp-ts/lib/Array";
import * as NEA from "fp-ts/lib/NonEmptyArray";
import * as TE from "fp-ts/lib/TaskEither";
import * as N from "fp-ts/number";
import * as O from "fp-ts/Option";
import { contramap } from "fp-ts/Ord";
import * as R from "fp-ts/Record";

import { pipe } from "fp-ts/lib/function";
import { IO } from "fp-ts/lib/IO";

const PENDING_INVOICES_URL =
  "https://recruiting.data.bemmbo.com/invoices/pending";

const getOrganizationUrl = (organizationId: string) =>
  `https://recruiting.data.bemmbo.com/organization/${organizationId}/settings`;

const getPayUrl = (paymentId: string) =>
  `https://recruiting.data.bemmbo.com/payment/${paymentId}/pay`;

const fetchTE = (...args: Parameters<typeof fetch>) =>
  pipe(
    TE.tryCatch(
      () => fetch(...args),
      (e): NetworkError => ({ type: "NetworkError", error: e })
    ),
    TE.flatMap((res) =>
      res.ok
        ? TE.right(res)
        : TE.left<HttpError>({
            type: "HttpError",
            status: res.status,
            statusText: res.statusText,
          })
    ),
    TE.flatMap((res) =>
      TE.tryCatch(
        () => res.json(),
        (e): ParseError => ({ type: "ParseError", error: e })
      )
    )
  );

const isInvoice = (x: any): x is Invoice =>
  x &&
  typeof x === "object" &&
  typeof x.id === "string" &&
  typeof x.organization_id === "string" &&
  typeof x.amount === "number" &&
  typeof x.currency === "string";

const validateInvoice = E.fromPredicate<unknown, Invoice, ParseError>(
  (maybeInvoice) => isInvoice(maybeInvoice),
  () => ({ type: "ParseError" as const, error: "Not a valid array" })
);

const validateArray = E.fromPredicate<Array<unknown>, ParseError>(
  (maybeArray) => Array.isArray(maybeArray),
  () => ({ type: "ParseError" as const, error: "Not a valid array" })
);

const parseInvoicesE = (data: unknown): E.Either<ParseError, Invoice[]> =>
  pipe(
    data,
    E.fromPredicate(Array.isArray, () => ({
      type: "ParseError" as const,
      error: "Not a valid array",
    })),
    E.chain(A.traverse(E.Applicative)(validateInvoice))
  );

const getInvoices: TE.TaskEither<AppError, Invoice[]> = pipe(
  fetchTE(PENDING_INVOICES_URL),
  TE.chain((data) =>
    pipe(
      parseInvoicesE(data),
      E.mapLeft((e) => e as AppError),
      TE.fromEither
    )
  )
);

const getOrganizationSettings = (
  organizationId: string
): TE.TaskEither<AppError, OrganizationSettings> =>
  pipe(
    TE.tryCatch(
      () => fetch(getOrganizationUrl(organizationId)),
      (e): NetworkError => ({ type: "NetworkError", error: e })
    ),
    TE.flatMap((res) =>
      res.ok
        ? TE.right(res)
        : TE.left<HttpError>({
            type: "HttpError",
            status: res.status,
            statusText: res.statusText,
          })
    ),
    TE.flatMap((res) =>
      TE.tryCatch(
        () => res.json(),
        (e): ParseError => ({ type: "ParseError", error: e })
      )
    )
  );

const payPayment = (
  payment: PaymentPending
): TE.TaskEither<AppError, PaymentResponse> =>
  pipe(
    TE.tryCatch(
      () =>
        fetch(getPayUrl(payment.id), {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ amount: payment.amount }),
        }),
      (e): NetworkError => ({ type: "NetworkError", error: e })
    ),
    TE.flatMap((res) =>
      res.ok
        ? TE.right(res)
        : TE.left<HttpError>({
            type: "HttpError",
            status: res.status,
            statusText: res.statusText,
          })
    ),
    TE.flatMap((res) =>
      TE.tryCatch(
        () => res.json(),
        (e): ParseError => ({ type: "ParseError", error: e })
      )
    )
  );

const printCurr =
  (prefix: string = "") =>
  <T>(a: T) => {
    console.log(prefix, a);
    return a;
  };

const isInvoicedReceived = (inv: Invoice) => inv.type === "received";
const isCreditNote = (inv: Invoice) => inv.type === "credit_note";
const isPaymentPending = (p: Payment) => p.status === "pending";
const isPaymentPaid = (p: Payment) => p.status === "paid";

const partitionInvoices = (
  inv: Invoice
): E.Either<InvoiceReceived, CreditNote> =>
  isInvoicedReceived(inv) ? E.left(inv) : E.right(inv);

const USD_RATE: Record<Currency, number> = {
  USD: 1, // 1 USD = 1 USD
  CLP: 900, // 1 USD ≈ 950 CLP
  MXN: 15, // 1 USD ≈ 900 CLP ≈ 900 / 60 MXN ≈ 15 MXN
};

const convertToCurrency =
  (current: Currency, to: Currency) => (amount: number) => {
    if (current === to) return amount;
    const usdAmount = amount / USD_RATE[current];
    return usdAmount * USD_RATE[to];
  };

const getTotalCreditNoteByRef =
  (targetCurrency: Currency) =>
  (creditNotes: CreditNote[]): { [ref: string]: number } =>
    pipe(
      creditNotes,
      NEA.groupBy<CreditNote>((cn) => cn.reference),
      R.map(
        A.reduce(0, (total, curr) =>
          pipe(
            curr.amount,
            convertToCurrency(curr.currency, targetCurrency),
            (res) => total + res
          )
        )
      ),
      printCurr("getTotalCreditNoteByRef:")
    );

const sortPaymentsByAmount = A.sortBy([
  pipe(
    N.Ord,
    contramap((p: PaymentPending) => p.amount)
  ),
]);

const discountPayment = (discount: number) => (payment: PaymentPending) => ({
  ...payment,
  amount: Math.max(payment.amount - discount, 0),
});

const groupInvoicesByOrg = (
  invs: Invoice[]
): Record<string, NEA.NonEmptyArray<Invoice>> =>
  pipe(
    invs,
    printCurr("Invs:"),
    NEA.groupBy((inv) => inv.organization_id)
  );

const processInvoicePayment =
  (cns: { [ref: string]: number }, config: OrganizationSettings) =>
  (invoice: InvoiceReceived): TE.TaskEither<AppError, number> =>
    pipe(
      R.lookup<number>(invoice.id, cns),
      printCurr("InitialDiscount:"),
      (x) => x,
      O.match(
        () => TE.left<AppError>({ type: "FixError", error: undefined }),
        (initialDiscount) =>
          pipe(
            invoice.payments,
            A.filter(isPaymentPending),
            sortPaymentsByAmount,
            A.map((p) => ({
              ...p,
              amount: pipe(
                p.amount,
                convertToCurrency(invoice.currency, config.currency),
                printCurr(
                  `Old value: ${p.amount}${invoice.currency}; New value (${config.currency}): `
                )
              ),
            })),
            reducePaymentsTE(initialDiscount)
          )
      )
    );

const processInvoices =
  (config: OrganizationSettings) =>
  (invoices: Invoice[]): TE.TaskEither<AppError, number>[] =>
    pipe(
      invoices,
      A.partitionMap(partitionInvoices),
      ({ left: received, right: creditNotes }) =>
        pipe(creditNotes, getTotalCreditNoteByRef(config.currency), (cnbr) =>
          pipe(received, A.map(processInvoicePayment(cnbr, config)))
        )
    );

const processClientInvoices = (
  clientId: string,
  invoices: Invoice[]
): TE.TaskEither<AppError, readonly number[]> =>
  pipe(
    getOrganizationSettings(clientId),
    TE.chain((config) => TE.sequenceArray(processInvoices(config)(invoices)))
  );

async function main() {
  const result = pipe(
    getInvoices,
    TE.map(groupInvoicesByOrg),
    TE.map(R.toEntries),
    // TE.map(A.map(([clientId, invs]) => processClientInvoices(clientId, invs)))
    TE.chain((items) =>
      TE.sequenceArray(
        A.map<
          [string, NEA.NonEmptyArray<Invoice>],
          TE.TaskEither<AppError, readonly number[]>
        >(([clientId, invs]) => processClientInvoices(clientId, invs))(items)
      )
    )
  );

  const part1 = await result();
  console.log("Result:", part1);
  // const part1 = await TE.sequenceArray(result)();
  // console.log("Result:", part1);
}

const logIO =
  (label: string) =>
  <A>(a: A): IO<void> =>
  () =>
    console.log(label, a);

const reducePaymentsTE =
  (initialDiscount: number) => (payments: PaymentPending[]) =>
    pipe(
      payments,
      A.reduce<PaymentPending, TE.TaskEither<AppError, number>>(
        TE.of(initialDiscount),
        (accTE, p) =>
          pipe(
            accTE,
            TE.flatMap((discount) => {
              const discounted = discountPayment(discount)(p); // apply remaining discount to this payment
              return pipe(
                discounted,
                payPayment, // TE<AppError, PaymentResponse>
                TE.tapIO(
                  logIO(
                    `paymentResponse (id:${discounted.id}, amount:${discounted.amount}`
                  )
                ), // <-- logs the real JSON on success
                // TE.tapError(logErrorIO("Payment failed:")), // <-- logs errors
                TE.map(() => {
                  console.log("Current Dis:", discount);
                  return Math.max(discount - p.amount, 0);
                }) // remaining discount after using min(discount, p.amount)
              );
            })
          )
      )
    );

// FIX:
// - Use Task to create async flow for fetching
// - Convert the response.json (unknown | any) to Invoice

main();
