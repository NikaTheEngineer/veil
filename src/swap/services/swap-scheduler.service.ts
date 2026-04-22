import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  SwapStatus as PrismaSwapStatus,
  SwapTrancheStatus,
} from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service.js";
import { SwapExecutionService } from "./swap-execution.service.js";
import { SwapProgressService } from "./swap-progress.service.js";

@Injectable()
export class SwapSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SwapSchedulerService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly swapExecutionService: SwapExecutionService,
    private readonly swapProgressService: SwapProgressService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") {
      return;
    }

    const intervalMs = Number(process.env.SWAP_SCHEDULER_INTERVAL_MS ?? "5000");
    this.timer = setInterval(() => {
      void this.processDueTranches();
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async processDueTranches(now: Date = new Date()): Promise<void> {
    const dueTranches = await this.prisma.swapTranche.findMany({
      where: {
        status: SwapTrancheStatus.ADDRESS_GENERATED,
        executeAtUtc: { lte: now },
        swapJob: {
          status: {
            in: [PrismaSwapStatus.PLANNED, PrismaSwapStatus.IN_PROGRESS],
          },
        },
      },
      orderBy: [{ executeAtUtc: "asc" }, { sequence: "asc" }],
      select: {
        id: true,
        swapJobId: true,
      },
    });

    const touchedSwapJobs = new Set<string>();

    for (const tranche of dueTranches) {
      try {
        await this.swapExecutionService.markTrancheReadyForExecution(
          tranche.id,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to advance due tranche ${tranche.id}: ${detail}`,
        );
      } finally {
        touchedSwapJobs.add(tranche.swapJobId);
      }
    }

    for (const swapJobId of touchedSwapJobs) {
      await this.swapProgressService.refreshAggregates(swapJobId);
    }
  }
}
