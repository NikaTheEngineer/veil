import type { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import type { JsonValue } from "../../common/types/json-value.js";

export interface CustodyTransactionInput {
  owner: string;
  mint: string;
  amount: string;
}

export interface PrivateBalanceInput {
  owner: string;
  mint: string;
}

export interface CustodyTransferInput {
  from: string;
  to: string;
  mint: string;
  amount: string;
  visibility: "public" | "private";
  fromBalance: "base" | "ephemeral";
  toBalance: "base" | "ephemeral";
  initIfMissing?: boolean;
  initAtasIfMissing?: boolean;
  initVaultIfMissing?: boolean;
  memo?: string;
  minDelayMs?: string;
  maxDelayMs?: string;
  split?: number;
}

export interface ProviderUnsignedTransaction {
  transactionBase64: string;
  raw: JsonValue;
}

export interface CustodyProviderStrategy {
  readonly provider: CustodyProvider;
  deposit(input: CustodyTransactionInput): Promise<ProviderUnsignedTransaction>;
  transfer(input: CustodyTransferInput): Promise<ProviderUnsignedTransaction>;
  withdraw(
    input: CustodyTransactionInput,
  ): Promise<ProviderUnsignedTransaction>;
  getPrivateBalance(input: PrivateBalanceInput): Promise<JsonValue>;
}
