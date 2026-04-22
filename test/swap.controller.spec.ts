import "reflect-metadata";

import { jest } from "@jest/globals";
import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
} from "@nestjs/common";

import { CustodyProvider } from "../src/common/enums/custody-provider.enum.js";
import { SwapExecutionMode } from "../src/common/enums/swap-execution-mode.enum.js";
import { SwapProvider } from "../src/common/enums/swap-provider.enum.js";
import { SwapStatus } from "../src/common/enums/swap-status.enum.js";
import { CreateInstantSwapDto } from "../src/swap/dto/create-instant-swap.dto.js";
import { CreateSwapDto } from "../src/swap/dto/create-swap.dto.js";
import { SwapOrchestrationService } from "../src/swap/services/swap-orchestration.service.js";
import { SwapProgressService } from "../src/swap/services/swap-progress.service.js";
import { SwapController } from "../src/swap/swap.controller.js";

describe("SwapController integration", () => {
  const validationPipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  async function validateBody<T>(
    metatype: new () => T,
    value: Record<string, string>,
  ): Promise<T> {
    return validationPipe.transform(value, {
      type: "body",
      metatype,
      data: "",
    }) as Promise<T>;
  }

  const swapOrchestrationService: jest.Mocked<
    Pick<SwapOrchestrationService, "createSwap" | "createInstantSwap">
  > = {
    createSwap: jest.fn(),
    createInstantSwap: jest.fn(),
  };
  const swapProgressService: jest.Mocked<
    Pick<SwapProgressService, "getSwapSummary" | "getSwapTranches">
  > = {
    getSwapSummary: jest.fn(),
    getSwapTranches: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects malformed swap creation payloads", async () => {
    await expect(
      validateBody(CreateSwapDto, {
        custodyProvider: "MAGICBLOCK",
        swapProvider: "FLY",
        executionMode: "BROKEN",
        fromMint: "So11111111111111111111111111111111111111112",
        toMint: "So11111111111111111111111111111111111111112",
        fromAmount: "10",
        targetToAmount: "9",
        slippage: "0.005",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("requires executionMode on swap creation payloads", async () => {
    await expect(
      validateBody(CreateSwapDto, {
        custodyProvider: "MAGICBLOCK",
        swapProvider: "FLY",
        fromMint: "So11111111111111111111111111111111111111112",
        toMint: "So11111111111111111111111111111111111111112",
        fromAmount: "10",
        targetToAmount: "9",
        slippage: "0.005",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("delegates valid create requests", async () => {
    const orchestrationServiceStub = Object.assign(
      Object.create(SwapOrchestrationService.prototype),
      swapOrchestrationService,
    ) as SwapOrchestrationService;
    const progressServiceStub = Object.assign(
      Object.create(SwapProgressService.prototype),
      swapProgressService,
    ) as SwapProgressService;
    const controller = new SwapController(
      orchestrationServiceStub,
      progressServiceStub,
    );
    const dto = await validateBody(CreateSwapDto, {
      custodyProvider: "MAGICBLOCK",
      swapProvider: "FLY",
      executionMode: "FAST",
      fromMint: "So11111111111111111111111111111111111111112",
      toMint: "So11111111111111111111111111111111111111112",
      fromAmount: "10",
      targetToAmount: "9",
      slippage: "0.005",
    });

    swapOrchestrationService.createSwap.mockResolvedValue({
      id: "swap-id",
      custodyProvider: CustodyProvider.MAGICBLOCK,
      swapProvider: SwapProvider.FLY,
      executionMode: SwapExecutionMode.FAST,
      fromMint: "So11111111111111111111111111111111111111112",
      toMint: "So11111111111111111111111111111111111111112",
      fromAmount: "10",
      targetToAmount: "9",
      slippage: "0.005",
      status: SwapStatus.PLANNED,
      plannedFromAmount: "10",
      swappedFromAmount: "0",
      remainingFromAmount: "10",
      plannedTranches: 1,
      readyTranches: 0,
      fundedTranches: 0,
      submittedSwapTranches: 0,
      depositedTranches: 0,
      failedTranches: 0,
      createdAt: "2026-04-21T12:00:00.000Z",
      updatedAt: "2026-04-21T12:00:00.000Z",
    });

    await controller.createSwap(dto);

    expect(swapOrchestrationService.createSwap).toHaveBeenCalledWith(dto);
  });

  it("delegates valid instant swap requests", async () => {
    const orchestrationServiceStub = Object.assign(
      Object.create(SwapOrchestrationService.prototype),
      swapOrchestrationService,
    ) as SwapOrchestrationService;
    const progressServiceStub = Object.assign(
      Object.create(SwapProgressService.prototype),
      swapProgressService,
    ) as SwapProgressService;
    const controller = new SwapController(
      orchestrationServiceStub,
      progressServiceStub,
    );
    const dto = await validateBody(CreateInstantSwapDto, {
      custodyProvider: "MAGICBLOCK",
      swapProvider: "FLY",
      fromMint: "So11111111111111111111111111111111111111112",
      toMint: "So11111111111111111111111111111111111111112",
      fromAmount: "10",
      slippage: "0.005",
    });

    swapOrchestrationService.createInstantSwap.mockResolvedValue({
      id: "swap-id",
      custodyProvider: CustodyProvider.MAGICBLOCK,
      swapProvider: SwapProvider.FLY,
      executionMode: SwapExecutionMode.INSTANT,
      fromMint: "So11111111111111111111111111111111111111112",
      toMint: "So11111111111111111111111111111111111111112",
      fromAmount: "10",
      targetToAmount: "0",
      slippage: "0.005",
      status: SwapStatus.IN_PROGRESS,
      plannedFromAmount: "10",
      swappedFromAmount: "0",
      remainingFromAmount: "10",
      plannedTranches: 1,
      readyTranches: 0,
      fundedTranches: 1,
      submittedSwapTranches: 0,
      depositedTranches: 0,
      failedTranches: 0,
      createdAt: "2026-04-21T12:00:00.000Z",
      updatedAt: "2026-04-21T12:00:00.000Z",
    });

    await controller.createInstantSwap(dto);

    expect(swapOrchestrationService.createInstantSwap).toHaveBeenCalledWith(
      dto,
    );
  });

  it("surfaces not found for missing swap ids", async () => {
    const orchestrationServiceStub = Object.assign(
      Object.create(SwapOrchestrationService.prototype),
      swapOrchestrationService,
    ) as SwapOrchestrationService;
    const progressServiceStub = Object.assign(
      Object.create(SwapProgressService.prototype),
      swapProgressService,
    ) as SwapProgressService;
    const controller = new SwapController(
      orchestrationServiceStub,
      progressServiceStub,
    );
    swapProgressService.getSwapSummary.mockRejectedValue(
      new NotFoundException("missing"),
    );

    await expect(
      controller.getSwap("3b2bb2a2-3ec8-4f8f-ae6a-0f95db59d81f"),
    ).rejects.toThrow(NotFoundException);
  });

  it("returns tranche reads from the progress service", async () => {
    const orchestrationServiceStub = Object.assign(
      Object.create(SwapOrchestrationService.prototype),
      swapOrchestrationService,
    ) as SwapOrchestrationService;
    const progressServiceStub = Object.assign(
      Object.create(SwapProgressService.prototype),
      swapProgressService,
    ) as SwapProgressService;
    const controller = new SwapController(
      orchestrationServiceStub,
      progressServiceStub,
    );
    swapProgressService.getSwapTranches.mockResolvedValue({
      swapId: "swap-id",
      tranches: [],
    });

    const result = await controller.getSwapTranches(
      "3b2bb2a2-3ec8-4f8f-ae6a-0f95db59d81f",
    );

    expect(result).toEqual({
      swapId: "swap-id",
      tranches: [],
    });
  });
});
