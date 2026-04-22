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

export interface ProviderUnsignedTransaction {
  transactionBase64: string;
  raw: JsonValue;
}

export interface CustodyProviderStrategy {
  readonly provider: CustodyProvider;
  deposit(input: CustodyTransactionInput): Promise<ProviderUnsignedTransaction>;
  withdraw(
    input: CustodyTransactionInput,
  ): Promise<ProviderUnsignedTransaction>;
  getPrivateBalance(input: PrivateBalanceInput): Promise<JsonValue>;
}
