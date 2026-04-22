import type { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import type { SwapExecutionMode } from "../../common/enums/swap-execution-mode.enum.js";
import type { SwapProvider } from "../../common/enums/swap-provider.enum.js";
import type { SwapStatus } from "../../common/enums/swap-status.enum.js";
import type { SwapTrancheStatus } from "../../common/enums/swap-tranche-status.enum.js";

export interface SwapJobSummaryResponse {
  id: string;
  custodyProvider: CustodyProvider;
  swapProvider: SwapProvider;
  executionMode: SwapExecutionMode;
  fromMint: string;
  toMint: string;
  fromAmount: string;
  targetToAmount: string;
  slippage: string;
  status: SwapStatus;
  plannedFromAmount: string;
  swappedFromAmount: string;
  remainingFromAmount: string;
  sourceDepositSignature?: string | null;
  plannedTranches: number;
  readyTranches: number;
  fundedTranches: number;
  submittedSwapTranches: number;
  depositedTranches: number;
  failedTranches: number;
  createdAt: string;
  updatedAt: string;
}

export interface SwapTrancheResponse {
  id: string;
  plannedAmount: string;
  executeAtUtc: string;
  tempWalletPublicKey: string;
  status: SwapTrancheStatus;
  statusReason?: string | null;
  withdrawSignature?: string | null;
  fundingSignature?: string | null;
  swapSignature?: string | null;
  depositSignature?: string | null;
  lastError?: string | null;
  executedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SwapTrancheListResponse {
  swapId: string;
  tranches: SwapTrancheResponse[];
}
