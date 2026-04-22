import { Injectable, NotFoundException } from "@nestjs/common";
import { SwapStatus, SwapTrancheStatus } from "@prisma/client";

import type { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import type { SwapProvider } from "../../common/enums/swap-provider.enum.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import type { ReadySwapTrancheInput } from "../../wallet/interfaces/swap-provider.strategy.js";
import { FlySwapExecutionFailure } from "../../wallet/providers/fly-swap.strategy.js";
import { SwapProviderRegistry } from "../../wallet/providers/swap-provider.registry.js";
import { SwapProgressService } from "./swap-progress.service.js";

@Injectable()
export class SwapExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly swapProviderRegistry: SwapProviderRegistry,
    private readonly swapProgressService: SwapProgressService,
  ) {}

  async markTrancheReadyForExecution(
    trancheId: string,
    preloadedQuote?: ReadySwapTrancheInput["preloadedQuote"],
  ): Promise<void> {
    const tranche = await this.prisma.swapTranche.findUnique({
      where: { id: trancheId },
      include: { swapJob: true },
    });

    if (!tranche) {
      throw new NotFoundException(`Swap tranche not found: ${trancheId}`);
    }

    const strategy = this.swapProviderRegistry.get(
      tranche.swapJob.swapProvider as SwapProvider,
    );

    try {
      await strategy.markTrancheReady({
        swapJobId: tranche.swapJobId,
        trancheId: tranche.id,
        custodyProvider: tranche.swapJob.custodyProvider as CustodyProvider,
        swapProvider: tranche.swapJob.swapProvider as SwapProvider,
        fromMint: tranche.swapJob.fromMint,
        toMint: tranche.swapJob.toMint,
        amount: tranche.plannedAmount,
        tempWalletPublicKey: tranche.tempWalletPublicKey,
        preloadedQuote,
      });
    } catch (error) {
      const isFlyExecutionFailure = error instanceof FlySwapExecutionFailure;
      const statusReason = isFlyExecutionFailure
        ? this.toStatusReason(error)
        : "Tranche execution failed";
      const lastError = error instanceof Error ? error.message : String(error);

      await this.prisma.swapTranche.update({
        where: { id: trancheId },
        data: {
          status: SwapTrancheStatus.FAILED,
          statusReason,
          lastError,
        },
      });
      if (isFlyExecutionFailure && error.shouldPauseSwapJob) {
        await this.prisma.swapJob.update({
          where: { id: tranche.swapJobId },
          data: {
            status: SwapStatus.PAUSED,
          },
        });
      }
      await this.swapProgressService.refreshAggregates(tranche.swapJobId);
      throw error;
    }

    await this.swapProgressService.refreshAggregates(tranche.swapJobId);
  }

  private toStatusReason(error: FlySwapExecutionFailure): string {
    switch (error.code) {
      case "QUOTE_EXPIRED":
        return "QUOTE_EXPIRED";
      case "SLIPPAGE_EXCEEDED":
        return "SLIPPAGE_EXCEEDED";
      case "COMPENSATION_FAILED":
        return "REFUND_FAILED";
    }
  }
}
