import { Injectable, NotFoundException } from "@nestjs/common";
import {
  type Prisma,
  SwapStatus as PrismaSwapStatus,
  SwapTrancheStatus as PrismaSwapTrancheStatus,
  type SwapJob,
  type SwapTranche,
} from "@prisma/client";

import type { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import type { SwapExecutionMode } from "../../common/enums/swap-execution-mode.enum.js";
import type { SwapProvider } from "../../common/enums/swap-provider.enum.js";
import type { SwapStatus } from "../../common/enums/swap-status.enum.js";
import type { SwapTrancheStatus } from "../../common/enums/swap-tranche-status.enum.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import type {
  SwapJobSummaryResponse,
  SwapTrancheListResponse,
  SwapTrancheResponse,
} from "../interfaces/swap-response.js";

type SwapJobWithTranches = SwapJob & { tranches: SwapTranche[] };

@Injectable()
export class SwapProgressService {
  constructor(private readonly prisma: PrismaService) {}

  async getSwapSummary(id: string): Promise<SwapJobSummaryResponse> {
    const swapJob = await this.prisma.swapJob.findUnique({
      where: { id },
      include: { tranches: true },
    });

    if (!swapJob) {
      throw new NotFoundException(`Swap job not found: ${id}`);
    }

    return this.toSwapSummary(swapJob);
  }

  async getSwapTranches(id: string): Promise<SwapTrancheListResponse> {
    const swapJob = await this.prisma.swapJob.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!swapJob) {
      throw new NotFoundException(`Swap job not found: ${id}`);
    }

    const tranches = await this.prisma.swapTranche.findMany({
      where: { swapJobId: id },
      orderBy: [{ sequence: "asc" }],
    });

    return {
      swapId: id,
      tranches: tranches.map((tranche) => this.toTranche(tranche)),
    };
  }

  async refreshAggregates(
    swapJobId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const swapJob = await client.swapJob.findUnique({
      where: { id: swapJobId },
      include: { tranches: true },
    });

    if (!swapJob) {
      throw new NotFoundException(`Swap job not found: ${swapJobId}`);
    }

    const swappedStatuses: PrismaSwapTrancheStatus[] = [
      PrismaSwapTrancheStatus.SWAPPED,
      PrismaSwapTrancheStatus.DEPOSIT_SUBMITTED,
      PrismaSwapTrancheStatus.COMPLETED,
    ];
    const fundedStatuses: PrismaSwapTrancheStatus[] = [
      PrismaSwapTrancheStatus.FUNDING_SUBMITTED,
      PrismaSwapTrancheStatus.FUNDED,
      PrismaSwapTrancheStatus.QUOTE_RECEIVED,
      PrismaSwapTrancheStatus.SWAP_SUBMITTED,
      PrismaSwapTrancheStatus.SWAPPED,
      PrismaSwapTrancheStatus.DEPOSIT_SUBMITTED,
      PrismaSwapTrancheStatus.COMPLETED,
    ];
    const submittedSwapStatuses: PrismaSwapTrancheStatus[] = [
      PrismaSwapTrancheStatus.SWAP_SUBMITTED,
      PrismaSwapTrancheStatus.SWAPPED,
      PrismaSwapTrancheStatus.DEPOSIT_SUBMITTED,
      PrismaSwapTrancheStatus.COMPLETED,
    ];
    const depositedStatuses: PrismaSwapTrancheStatus[] = [
      PrismaSwapTrancheStatus.DEPOSIT_SUBMITTED,
      PrismaSwapTrancheStatus.COMPLETED,
    ];

    const swappedAmount = swapJob.tranches
      .filter((tranche) => swappedStatuses.includes(tranche.status))
      .reduce((sum, tranche) => sum + BigInt(tranche.plannedAmount), 0n);

    const readyTranches = swapJob.tranches.filter(
      (tranche) => tranche.status === PrismaSwapTrancheStatus.ADDRESS_GENERATED,
    ).length;
    const fundedTranches = swapJob.tranches.filter((tranche) =>
      fundedStatuses.includes(tranche.status),
    ).length;
    const submittedSwapTranches = swapJob.tranches.filter((tranche) =>
      submittedSwapStatuses.includes(tranche.status),
    ).length;
    const depositedTranches = swapJob.tranches.filter((tranche) =>
      depositedStatuses.includes(tranche.status),
    ).length;
    const failedTranches = swapJob.tranches.filter(
      (tranche) => tranche.status === PrismaSwapTrancheStatus.FAILED,
    ).length;
    const totalTranches = swapJob.tranches.length;
    const remainingFromAmount = (
      BigInt(swapJob.fromAmount) - swappedAmount
    ).toString();

    await client.swapJob.update({
      where: { id: swapJobId },
      data: {
        swappedFromAmount: swappedAmount.toString(),
        remainingFromAmount,
        readyTranches,
        fundedTranches,
        submittedSwapTranches,
        depositedTranches,
        failedTranches,
        totalTranches,
        status: this.deriveStatus(
          swapJob.status,
          totalTranches,
          depositedTranches,
          fundedTranches,
          failedTranches,
        ),
      },
    });
  }

  toSwapSummary(swapJob: SwapJobWithTranches): SwapJobSummaryResponse {
    return {
      id: swapJob.id,
      custodyProvider: swapJob.custodyProvider as CustodyProvider,
      swapProvider: swapJob.swapProvider as SwapProvider,
      executionMode: swapJob.executionMode as SwapExecutionMode,
      fromMint: swapJob.fromMint,
      toMint: swapJob.toMint,
      fromAmount: swapJob.fromAmount,
      targetToAmount: swapJob.targetToAmount,
      slippage: swapJob.slippage,
      status: swapJob.status as SwapStatus,
      plannedFromAmount: swapJob.plannedFromAmount,
      swappedFromAmount: swapJob.swappedFromAmount,
      remainingFromAmount: swapJob.remainingFromAmount,
      sourceDepositSignature: swapJob.sourceDepositSignature,
      plannedTranches: swapJob.totalTranches,
      readyTranches: swapJob.readyTranches,
      fundedTranches: swapJob.fundedTranches,
      submittedSwapTranches: swapJob.submittedSwapTranches,
      depositedTranches: swapJob.depositedTranches,
      failedTranches: swapJob.failedTranches,
      createdAt: swapJob.createdAt.toISOString(),
      updatedAt: swapJob.updatedAt.toISOString(),
    };
  }

  private toTranche(tranche: SwapTranche): SwapTrancheResponse {
    return {
      id: tranche.id,
      plannedAmount: tranche.plannedAmount,
      executeAtUtc: tranche.executeAtUtc.toISOString(),
      tempWalletPublicKey: tranche.tempWalletPublicKey,
      status: tranche.status as SwapTrancheStatus,
      statusReason: tranche.statusReason,
      withdrawSignature: tranche.withdrawSignature,
      fundingSignature: tranche.fundingSignature,
      swapSignature: tranche.swapSignature,
      depositSignature: tranche.depositSignature,
      lastError: tranche.lastError,
      executedAt: tranche.executedAt?.toISOString() ?? null,
      createdAt: tranche.createdAt.toISOString(),
      updatedAt: tranche.updatedAt.toISOString(),
    };
  }

  private deriveStatus(
    currentStatus: PrismaSwapStatus,
    totalTranches: number,
    depositedTranches: number,
    fundedTranches: number,
    failedTranches: number,
  ): PrismaSwapStatus {
    if (currentStatus === PrismaSwapStatus.PAUSED) {
      return PrismaSwapStatus.PAUSED;
    }

    if (totalTranches === 0) {
      return PrismaSwapStatus.PLANNED;
    }

    if (depositedTranches === totalTranches) {
      return PrismaSwapStatus.COMPLETED;
    }

    if (failedTranches === totalTranches) {
      return PrismaSwapStatus.FAILED;
    }

    if (fundedTranches > 0) {
      return PrismaSwapStatus.IN_PROGRESS;
    }

    return PrismaSwapStatus.PLANNED;
  }
}
