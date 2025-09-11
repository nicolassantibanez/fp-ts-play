type Currency = "USD" | "CLP" | "MXN";

type CreditNote = Readonly<{
  id: string;
  amount: number;
  currency: Currency;
  organization_id: string;
  type: "credit_note";
  reference: string;
}>;

type PaymentPending = Readonly<{
  id: string;
  amount: number;
  status: "pending";
}>;

type PaymentPaid = Readonly<{
  id: string;
  amount: number;
  status: "paid";
}>;

type Payment = PaymentPending | PaymentPaid;

type InvoiceReceived = Readonly<{
  id: string;
  amount: number;
  currency: Currency;
  organization_id: string;
  type: "received";
  payments: Payment[];
}>;

type OrganizationSettings = Readonly<{
  organization_id: string;
  currency: Currency;
}>;

type Invoice = InvoiceReceived | CreditNote;

type NetworkError = { type: "NetworkError"; error: unknown };
type HttpError = { type: "HttpError"; status: number; statusText: string };
type ParseError = { type: "ParseError"; error: unknown };
type FixError = { type: "FixError"; error: unknown };
type AppError = NetworkError | HttpError | ParseError | FixError;
