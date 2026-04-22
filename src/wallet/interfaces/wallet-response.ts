import type { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import type { WalletAction } from "../../common/enums/wallet-action.enum.js";
import type { JsonValue } from "../../common/types/json-value.js";

export interface WalletTransactionResponse {
  provider: CustodyProvider;
  action: WalletAction;
  owner: string;
  mint: string;
  amount: string;
  signature: string;
  providerPayload: {
    transactionBase64: string;
  };
}

export interface WalletBalanceResponse {
  provider: CustodyProvider;
  owner: string;
  mint: string;
  data: JsonValue;
}
