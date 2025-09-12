import * as E from "fp-ts/Either";
import * as A from "fp-ts/lib/Array";
import * as NEA from "fp-ts/lib/NonEmptyArray";
import * as TE from "fp-ts/lib/TaskEither";
import * as N from "fp-ts/number";
import * as O from "fp-ts/Option";
import { contramap } from "fp-ts/Ord";
import * as R from "fp-ts/Record";

import * as util from "util";

import { pipe } from "fp-ts/lib/function";

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

const isPaymentResp = (x: any): x is PaymentResp =>
  x &&
  typeof x === "object" &&
  typeof x.status === "string" &&
  (x.status === "paid" || x.status === "wrong_amount");

const isOrganizationSettings = (x: any): x is OrganizationSettings =>
  x &&
  typeof x === "object" &&
  typeof x.organization_id === "string" &&
  (x.currency === "USD" || x.currency === "CLP" || x.currency === "MXN");

const validateInvoice = E.fromPredicate<unknown, Invoice, ParseError>(
  (maybeInvoice) => isInvoice(maybeInvoice),
  () => ({ type: "ParseError" as const, error: "Not a valid Invoice" })
);

const validatePaymentResp = E.fromPredicate<unknown, PaymentResp, ParseError>(
  (maybePS) => isPaymentResp(maybePS),
  () => ({ type: "ParseError" as const, error: "Not a valid PaymentStatus" })
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

const parseOrganizationSettings = (
  data: unknown
): E.Either<ParseError, OrganizationSettings> =>
  pipe(
    data,
    E.fromPredicate(isOrganizationSettings, () => ({
      type: "ParseError" as const,
      error: "Not a valid OrganizationSettings",
    }))
  );

const getOrganizationSettings = (
  organizationId: string
): TE.TaskEither<AppError, OrganizationSettings> =>
  pipe(
    fetchTE(getOrganizationUrl(organizationId)),
    TE.flatMap((data) => pipe(parseOrganizationSettings(data), TE.fromEither))
  );

const parsePaymentResp = (data: unknown): E.Either<ParseError, PaymentResp> =>
  pipe(data, validatePaymentResp);

const payPayment = (
  payment: PaymentPending
): TE.TaskEither<AppError, PaidPaymentStatus> =>
  pipe(
    fetchTE(getPayUrl(payment.id), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: payment.amount }),
    }),
    TE.chainW((data) =>
      pipe(
        data,
        parsePaymentResp,
        E.map((resp) => ({ payment, status: resp.status })),
        TE.fromEither
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
  (creditNotes: CreditNote[]): AmountByReference =>
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
      )
    );

const sortPaymentsByAmount = A.sortBy([
  pipe(
    N.Ord,
    contramap((p: PaymentPending) => p.amount)
  ),
]);

const discountPayment =
  (discount: number) =>
  (payment: PaymentPending): PaymentPending => ({
    ...payment,
    amount: Math.max(payment.amount - discount, 0),
  });

const groupInvoicesByOrg = (
  invs: Invoice[]
): Record<string, NEA.NonEmptyArray<Invoice>> =>
  pipe(
    invs,
    NEA.groupBy((inv) => inv.organization_id)
  );

const processInvoicePayment =
  (cns: AmountByReference, config: OrganizationSettings) =>
  (invoice: InvoiceReceived): TE.TaskEither<AppError, PaidPaymentStatus[]> =>
    pipe(
      R.lookup(invoice.id, cns),
      O.getOrElse(() => 0),
      (initialDiscount) =>
        pipe(
          invoice.payments,
          A.filter(isPaymentPending),
          sortPaymentsByAmount,
          A.map((p) => ({
            ...p,
            amount: pipe(
              p.amount,
              convertToCurrency(invoice.currency, config.currency)
            ),
          })),
          discountPayments(initialDiscount),
          payPayments
        )
    );

const processInvoices =
  (config: OrganizationSettings) =>
  (invoices: Invoice[]): TE.TaskEither<AppError, PaidPaymentStatus[]> =>
    pipe(
      invoices,
      A.partitionMap(partitionInvoices),
      ({ left: received, right: creditNotes }) =>
        pipe(creditNotes, getTotalCreditNoteByRef(config.currency), (cnbr) =>
          pipe(
            received,
            A.map(processInvoicePayment(cnbr, config)),
            A.sequence(TE.ApplicativeSeq),
            TE.map(A.flatten)
          )
        )
    );

const processClientInvoices = (
  clientId: string,
  invoices: Invoice[]
): TE.TaskEither<AppError, PaidPaymentStatus[]> =>
  pipe(
    getOrganizationSettings(clientId),
    TE.flatMap((config) => pipe(invoices, processInvoices(config)))
  );

const payPayments = (
  payments: PaymentPending[]
): TE.TaskEither<AppError, PaidPaymentStatus[]> =>
  pipe(payments, A.map(payPayment), A.sequence(TE.ApplicativePar));

const discountPayments =
  (initialDiscount: number) =>
  (payments: PaymentPending[]): PaymentPending[] =>
    pipe(
      payments,
      A.reduce<
        PaymentPending,
        { discount: number; processed: PaymentPending[] }
      >({ discount: initialDiscount, processed: [] }, (state, p) =>
        pipe(p, discountPayment(state.discount), (newPayment) => {
          const discountLeft = Math.max(state.discount - p.amount, 0);
          return {
            discount: discountLeft,
            processed: [...state.processed, newPayment],
          };
        })
      ),
      (state) => state.processed
    );

async function main() {
  const process = pipe(
    getInvoices,
    TE.map(groupInvoicesByOrg),
    TE.map(R.toEntries),
    TE.flatMap((items) =>
      pipe(
        items,
        A.map(([clientId, invs]) => processClientInvoices(clientId, invs)),
        A.sequence(TE.ApplicativeSeq),
        TE.map(A.flatten)
      )
    )
  );

  const result = await process();
  // console.log("Result:", result);
  console.log(
    util.inspect(result, { showHidden: false, depth: null, colors: true })
  );
}

main();
