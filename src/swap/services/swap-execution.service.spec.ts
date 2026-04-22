import { jest } from "@jest/globals";
import {
  SwapStatus as PrismaSwapStatus,
  SwapTrancheStatus,
} from "@prisma/client";

import { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import { SwapExecutionMode } from "../../common/enums/swap-execution-mode.enum.js";
import { SwapProvider } from "../../common/enums/swap-provider.enum.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { FlySwapExecutionFailure } from "../../wallet/providers/fly-swap.strategy.js";
import { SwapProviderRegistry } from "../../wallet/providers/swap-provider.registry.js";
import { SwapExecutionService } from "./swap-execution.service.js";
import { SwapProgressService } from "./swap-progress.service.js";

describe("SwapExecutionService", () => {
  it("marks a scheduled tranche failed and pauses the swap job on slippage failure", async () => {
    const prisma = {
      swapTranche: {
        findUnique: jest.fn(async () => ({
          id: "tranche-1",
          swapJobId: "swap-1",
          plannedAmount: "10",
          tempWalletPublicKey: "temp-wallet",
          swapJob: {
            custodyProvider: CustodyProvider.MAGICBLOCK,
            swapProvider: SwapProvider.FLY,
            fromMint: "11111111111111111111111111111111",
            toMint: "So11111111111111111111111111111111111111112",
            status: PrismaSwapStatus.IN_PROGRESS,
            executionMode: SwapExecutionMode.FAST,
          },
        })),
        update: jest.fn(async () => undefined),
      },
      swapJob: {
        update: jest.fn(async () => undefined),
      },
    };
    const swapProviderRegistry = {
      get: jest.fn().mockReturnValue({
        markTrancheReady: jest.fn(async () => {
          throw new FlySwapExecutionFailure(
            "Execution failed because market pricing moved outside slippage tolerance. Source funds were returned to MagicBlock custody.",
            "SLIPPAGE_EXCEEDED",
            true,
          );
        }),
      }),
    };
    const swapProgressService = {
      refreshAggregates: jest.fn(async () => undefined),
    };

    const service = new SwapExecutionService(
      Object.assign(
        Object.create(PrismaService.prototype),
        prisma,
      ) as PrismaService,
      Object.assign(
        Object.create(SwapProviderRegistry.prototype),
        swapProviderRegistry,
      ) as SwapProviderRegistry,
      Object.assign(
        Object.create(SwapProgressService.prototype),
        swapProgressService,
      ) as SwapProgressService,
    );

    await expect(
      service.markTrancheReadyForExecution("tranche-1"),
    ).rejects.toThrow(FlySwapExecutionFailure);

    expect(prisma.swapTranche.update).toHaveBeenCalledWith({
      where: { id: "tranche-1" },
      data: {
        status: SwapTrancheStatus.FAILED,
        statusReason: "SLIPPAGE_EXCEEDED",
        lastError:
          "Execution failed because market pricing moved outside slippage tolerance. Source funds were returned to MagicBlock custody.",
      },
    });
    expect(prisma.swapJob.update).toHaveBeenCalledWith({
      where: { id: "swap-1" },
      data: {
        status: PrismaSwapStatus.PAUSED,
      },
    });
    expect(swapProgressService.refreshAggregates).toHaveBeenCalledWith(
      "swap-1",
    );
  });

  it("marks an instant tranche failed without pausing the job", async () => {
    const prisma = {
      swapTranche: {
        findUnique: jest.fn(async () => ({
          id: "tranche-1",
          swapJobId: "swap-1",
          plannedAmount: "10",
          tempWalletPublicKey: "temp-wallet",
          swapJob: {
            custodyProvider: CustodyProvider.MAGICBLOCK,
            swapProvider: SwapProvider.FLY,
            fromMint: "11111111111111111111111111111111",
            toMint: "So11111111111111111111111111111111111111112",
            status: PrismaSwapStatus.PLANNED,
            executionMode: SwapExecutionMode.INSTANT,
          },
        })),
        update: jest.fn(async () => undefined),
      },
      swapJob: {
        update: jest.fn(async () => undefined),
      },
    };
    const swapProviderRegistry = {
      get: jest.fn().mockReturnValue({
        markTrancheReady: jest.fn(async () => {
          throw new FlySwapExecutionFailure(
            "Quote expired before execution. Source funds were returned to the origin wallet.",
            "QUOTE_EXPIRED",
            false,
          );
        }),
      }),
    };
    const swapProgressService = {
      refreshAggregates: jest.fn(async () => undefined),
    };

    const service = new SwapExecutionService(
      Object.assign(
        Object.create(PrismaService.prototype),
        prisma,
      ) as PrismaService,
      Object.assign(
        Object.create(SwapProviderRegistry.prototype),
        swapProviderRegistry,
      ) as SwapProviderRegistry,
      Object.assign(
        Object.create(SwapProgressService.prototype),
        swapProgressService,
      ) as SwapProgressService,
    );

    await expect(
      service.markTrancheReadyForExecution("tranche-1"),
    ).rejects.toThrow(FlySwapExecutionFailure);

    expect(prisma.swapJob.update).not.toHaveBeenCalled();
    expect(prisma.swapTranche.update).toHaveBeenCalledWith({
      where: { id: "tranche-1" },
      data: {
        status: SwapTrancheStatus.FAILED,
        statusReason: "QUOTE_EXPIRED",
        lastError:
          "Quote expired before execution. Source funds were returned to the origin wallet.",
      },
    });
  });
});
