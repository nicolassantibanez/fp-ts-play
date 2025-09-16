import * as E from "fp-ts/Either";
import * as A from "fp-ts/lib/Array";
import * as NEA from "fp-ts/lib/NonEmptyArray";
import * as Sep from "fp-ts/lib/Separated";
import * as TE from "fp-ts/lib/TaskEither";
import * as N from "fp-ts/number";
import * as O from "fp-ts/Option";
import { contramap } from "fp-ts/Ord";
import * as R from "fp-ts/Record";
import * as S from "fp-ts/string";

import * as util from "util";

import { pipe } from "fp-ts/lib/function";

const PENDING_INVOICES_URL =
  "https://recruiting.data.bemmbo.com/invoices/pending";

const getOrganizationUrl = (organizationId: string) =>
  `https://recruiting.data.bemmbo.com/organization/${organizationId}/settings`;

const getPayUrl = (paymentId: string) =>
  `https://recruiting.data.bemmbo.com/payment/${paymentId}/pay`;

const getResponseJsonTE = (res: Response) =>
  TE.tryCatch(
    () => res.json(),
    (e): ParseError => ({ type: "ParseError", error: e })
  );

//Typificar el rertorno
const fetchTE = (
  ...args: Parameters<typeof fetch>
): TE.TaskEither<ParseError | NetworkError | HttpError, any> =>
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
    TE.flatMap(getResponseJsonTE)
  );

const isInvoice = (maybeInvoice: any): maybeInvoice is Invoice =>
  maybeInvoice &&
  typeof maybeInvoice === "object" &&
  typeof maybeInvoice.id === "string" &&
  typeof maybeInvoice.organization_id === "string" &&
  typeof maybeInvoice.amount === "number" &&
  typeof maybeInvoice.currency === "string";

const isPaymentResponse = (
  maybePaymentResponse: any
): maybePaymentResponse is PaymentResponseType =>
  maybePaymentResponse &&
  typeof maybePaymentResponse === "object" &&
  typeof maybePaymentResponse.status === "string" &&
  (maybePaymentResponse.status === "paid" ||
    maybePaymentResponse.status === "wrong_amount");

const isOrganizationSettings = (
  maybeOrganizationSetting: any
): maybeOrganizationSetting is OrganizationSettings =>
  maybeOrganizationSetting &&
  typeof maybeOrganizationSetting === "object" &&
  typeof maybeOrganizationSetting.organization_id === "string" &&
  (maybeOrganizationSetting.currency === "USD" ||
    maybeOrganizationSetting.currency === "CLP" ||
    maybeOrganizationSetting.currency === "MXN");

const validateInvoice = (maybeInvoice: Invoice) =>
  pipe(
    maybeInvoice,
    E.fromPredicate(
      isInvoice,
      (): ParseError => ({
        type: "ParseError" as const,
        error: "Not a valid Invoice",
      })
    )
  );

const validatePaymentResp = (maybePaymentResponse: unknown) =>
  pipe(
    maybePaymentResponse,
    E.fromPredicate(
      isPaymentResponse,
      (): ParseError => ({
        type: "ParseError" as const,
        error: "Not a valid PaymentStatus",
      })
    )
  );

const parseInvoicesE = (
  maybeInvoices: unknown
): E.Either<ParseError, Invoice[]> =>
  pipe(
    maybeInvoices,
    E.fromPredicate(Array.isArray, () => ({
      type: "ParseError" as const,
      error: "Not a valid array",
    })),
    E.chain(A.traverse(E.Applicative)(validateInvoice))
  );

//Typificar retornoo y no usar unknown
const parseInvoicesTE = (data: unknown) =>
  pipe(data, parseInvoicesE, TE.fromEither);

const getInvoices: TE.TaskEither<AppError, Invoice[]> = pipe(
  fetchTE(PENDING_INVOICES_URL),
  TE.flatMap(parseInvoicesTE)
);

const parseOrganizationSettings = (
  data: unknown
): E.Either<ParseError, OrganizationSettings> =>
  pipe(
    data,
    E.fromPredicate(
      isOrganizationSettings,
      (): ParseError => ({
        type: "ParseError" as const,
        error: "Not a valid OrganizationSettings",
      })
    )
  );

const parseOrganizationSettingsTE = (data: unknown) =>
  pipe(parseOrganizationSettings(data), TE.fromEither);

const getOrganizationSettings = (
  organizationId: string
): TE.TaskEither<AppError, OrganizationSettings> =>
  pipe(
    fetchTE(getOrganizationUrl(organizationId)),
    TE.flatMap(parseOrganizationSettingsTE)
  );

const parsePaymentResponse = (data: unknown) => pipe(data, validatePaymentResp);

const parsePaymentResponseTE = (payment: PaymentPending) => (data: unknown) =>
  pipe(
    data,
    parsePaymentResponse,
    E.map((resp) => ({ payment, status: resp.status })),
    TE.fromEither
  );

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
    TE.flatMap(parsePaymentResponseTE(payment))
  );

const isInvoicedReceived = (inv: Invoice): inv is InvoiceReceived =>
  inv.type === "received";
const isPaymentPending = (p: Payment): p is PaymentPending =>
  p.status === "pending";

const partitionInvoices = (invoice: Invoice) =>
  pipe(
    invoice,
    E.fromPredicate(isInvoicedReceived, (inv): CreditNote => inv as CreditNote) // No logré hacer que fuera type-safe sin el cast
  );

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

const addInSameCurrency =
  (n1: number, fromCurrency: Currency, toCurrency: Currency) => (n2: number) =>
    pipe(
      n2,
      convertToCurrency(fromCurrency, toCurrency),
      (newN2) => n1 + newN2
    );

const calculateTotalOfCreditNotes =
  (targetCurrency: Currency) =>
  (creditNotes: CreditNote[]): number =>
    pipe(
      creditNotes,
      A.reduce(0, (sum, curr) =>
        addInSameCurrency(sum, curr.currency, targetCurrency)(curr.amount)
      )
    );

const getTotalCreditNoteByRef =
  (targetCurrency: Currency) =>
  (creditNotes: CreditNote[]): AmountByReference =>
    pipe(
      creditNotes,
      NEA.groupBy<CreditNote>((cn) => cn.reference),
      R.map(calculateTotalOfCreditNotes(targetCurrency))
    );

const sortByAmount = pipe(
  N.Ord,
  contramap((obj: { amount: number }) => obj.amount)
);

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

const changePendingPaymentCurrency =
  (fromCurrency: Currency, targetCurrency: Currency) =>
  (payment: PaymentPending) => ({
    ...payment,
    amount: convertToCurrency(fromCurrency, targetCurrency)(payment.amount),
  });

const processPayments =
  (
    payments: Payment[],
    invoiceCurrency: Currency,
    settingsCurrency: Currency
  ) =>
  (discount: number) =>
    pipe(
      payments,
      A.filter(isPaymentPending),
      A.sortBy([sortByAmount]),
      A.map(changePendingPaymentCurrency(invoiceCurrency, settingsCurrency)),
      discountPayments(discount),
      payPayments,
      A.sequence(TE.ApplicativeSeq)
    );

const processInvoicePayments =
  (amountByReference: AmountByReference, config: OrganizationSettings) =>
  (invoice: InvoiceReceived): TE.TaskEither<AppError, PaidPaymentStatus[]> =>
    pipe(
      R.lookup(invoice.id, amountByReference),
      O.getOrElse(() => 0),
      processPayments(invoice.payments, invoice.currency, config.currency)
    );

const processReceivedInvoices =
  (
    receivedInvoices: InvoiceReceived[],
    organizationSettings: OrganizationSettings
  ) =>
  (amountByReference: AmountByReference) =>
    pipe(
      receivedInvoices,
      A.map(processInvoicePayments(amountByReference, organizationSettings)),
      A.sequence(TE.ApplicativePar),
      TE.map(A.flatten)
    );

const processInvoices =
  (invoices: Invoice[]) =>
  (
    config: OrganizationSettings
  ): TE.TaskEither<AppError, PaidPaymentStatus[]> =>
    pipe(
      invoices,
      A.partitionMap(partitionInvoices),
      Sep.mapLeft(getTotalCreditNoteByRef(config.currency)),
      ({ left: amountByReference, right: received }) =>
        processReceivedInvoices(received, config)(amountByReference)
    );

const processClientInvoices = (
  clientId: string,
  invoices: Invoice[]
): TE.TaskEither<AppError, PaidPaymentStatus[]> =>
  pipe(
    getOrganizationSettings(clientId),
    TE.flatMap(processInvoices(invoices))
  );

const payPayments = (
  payments: PaymentPending[]
): TE.TaskEither<AppError, PaidPaymentStatus>[] =>
  pipe(payments, A.map(payPayment));

const applyDiscountToPayment =
  (discount: number, processed: PaymentPending[]) =>
  (payment: PaymentPending) =>
    pipe(payment, discountPayment(discount), (newPayment) => ({
      discount: Math.max(discount - payment.amount, 0),
      processed: [...processed, newPayment],
    }));

const discountPayments =
  (initialDiscount: number) =>
  (payments: PaymentPending[]): PaymentPending[] =>
    pipe(
      payments,
      A.reduce(
        { discount: initialDiscount, processed: [] as PaymentPending[] },
        (state, payment) =>
          applyDiscountToPayment(state.discount, state.processed)(payment)
      ),
      (state) => state.processed
    );

const processClients = (
  invoicesByOrganization: Record<string, NEA.NonEmptyArray<Invoice>>
): TE.TaskEither<AppError, PaidPaymentStatus[]> =>
  pipe(
    invoicesByOrganization,
    R.mapWithIndex(processClientInvoices),
    R.collect(S.Ord)((_, results) => results),
    A.sequence(TE.ApplicativePar),
    TE.map(A.flatten)
  );

async function main() {
  const process = pipe(
    getInvoices,
    TE.map(groupInvoicesByOrg),
    TE.map(processClients),
    TE.flatten
  );

  const result = await process();
  console.log(
    util.inspect(result, { showHidden: false, depth: null, colors: true })
  );
}

main();
