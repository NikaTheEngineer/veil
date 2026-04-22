import { jest } from "@jest/globals";

import { PrismaService } from "../../prisma/prisma.service.js";
import { SwapExecutionService } from "./swap-execution.service.js";
import { SwapProgressService } from "./swap-progress.service.js";
import { SwapSchedulerService } from "./swap-scheduler.service.js";

describe("SwapSchedulerService", () => {
  it("marks only due tranches and refreshes touched swap jobs", async () => {
    const findManyMock = jest.fn(async () => [
      { id: "tranche-1", swapJobId: "swap-1" },
      { id: "tranche-2", swapJobId: "swap-1" },
    ]);
    const markReadyMock = jest.fn(async () => undefined);
    const refreshAggregatesMock = jest.fn(async () => undefined);

    const prisma = {
      swapTranche: {
        findMany: findManyMock,
      },
    };
    const swapExecutionService = {
      markTrancheReadyForExecution: markReadyMock,
    };
    const swapProgressService = {
      refreshAggregates: refreshAggregatesMock,
    };
    const prismaStub = Object.assign(
      Object.create(PrismaService.prototype),
      prisma,
    ) as PrismaService;
    const swapExecutionServiceStub = Object.assign(
      Object.create(SwapExecutionService.prototype),
      swapExecutionService,
    ) as SwapExecutionService;
    const swapProgressServiceStub = Object.assign(
      Object.create(SwapProgressService.prototype),
      swapProgressService,
    ) as SwapProgressService;

    const service = new SwapSchedulerService(
      prismaStub,
      swapExecutionServiceStub,
      swapProgressServiceStub,
    );

    await service.processDueTranches(new Date("2026-04-21T12:20:00.000Z"));

    expect(prisma.swapTranche.findMany).toHaveBeenCalled();
    expect(
      swapExecutionService.markTrancheReadyForExecution,
    ).toHaveBeenCalledTimes(2);
    expect(swapProgressService.refreshAggregates).toHaveBeenCalledTimes(1);
    expect(swapProgressService.refreshAggregates).toHaveBeenCalledWith(
      "swap-1",
    );
  });
});
