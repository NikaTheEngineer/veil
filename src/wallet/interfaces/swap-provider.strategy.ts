import type { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import type { SwapExecutionMode } from "../../common/enums/swap-execution-mode.enum.js";
import type { SwapProvider } from "../../common/enums/swap-provider.enum.js";

export interface SwapExecutionPreparationInput {
  swapJobId: string;
  custodyProvider: CustodyProvider;
  swapProvider: SwapProvider;
  executionMode: SwapExecutionMode;
  fromMint: string;
  toMint: string;
  fromAmount: string;
  targetToAmount: string;
  slippage: string;
}

export interface ReadySwapTrancheInput {
  swapJobId: string;
  trancheId: string;
  custodyProvider: CustodyProvider;
  swapProvider: SwapProvider;
  fromMint: string;
  toMint: string;
  amount: string;
  tempWalletPublicKey: string;
}

export interface SwapProviderStrategy {
  readonly provider: SwapProvider;
  prepareExecution(input: SwapExecutionPreparationInput): Promise<void>;
  markTrancheReady(input: ReadySwapTrancheInput): Promise<void>;
}
