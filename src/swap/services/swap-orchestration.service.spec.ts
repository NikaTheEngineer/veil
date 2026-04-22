import { jest } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";
import { SwapStatus as PrismaSwapStatus } from "@prisma/client";
import {
  AnthropicPlanningFailureException,
  AnthropicPlanningService,
} from "../../ai-planning/anthropic-planning.service.js";
import { TranchePlanValidationService } from "../../ai-planning/tranche-plan-validation.service.js";
import { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import { SwapExecutionMode } from "../../common/enums/swap-execution-mode.enum.js";
import { SwapProvider } from "../../common/enums/swap-provider.enum.js";
import { SwapStatus } from "../../common/enums/swap-status.enum.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import type { CustodyProviderStrategy } from "../../wallet/interfaces/custody-provider.strategy.js";
import type { SwapProviderStrategy } from "../../wallet/interfaces/swap-provider.strategy.js";
import { CustodyProviderRegistry } from "../../wallet/providers/custody-provider.registry.js";
import { SwapProviderRegistry } from "../../wallet/providers/swap-provider.registry.js";
import { SolanaService } from "../../wallet/solana.service.js";
import { SwapExecutionService } from "./swap-execution.service.js";
import { SwapOrchestrationService } from "./swap-orchestration.service.js";
import {
  type SwapPlanningPolicy,
  SwapPlanningPolicyService,
} from "./swap-planning-policy.service.js";
import { SwapProgressService } from "./swap-progress.service.js";
import { TempWalletCryptoService } from "./temp-wallet-crypto.service.js";

interface TransactionClientStub {
  swapPlannerRun: {
    create: jest.MockedFunction<(args: object) => Promise<void>>;
  };
  swapTranche: {
    create: jest.MockedFunction<(args: object) => Promise<{ id: string }>>;
    updateMany: jest.MockedFunction<
      (args: object) => Promise<{ count: number }>
    >;
  };
  swapJob: {
    create: jest.MockedFunction<(args: object) => Promise<{ id: string }>>;
    update: jest.MockedFunction<(args: object) => Promise<void>>;
  };
}

type TransactionResult = undefined | { swapJobId: string; trancheId: string };

describe("SwapOrchestrationService", () => {
  const custodyProviderRegistry: jest.Mocked<
    Pick<CustodyProviderRegistry, "get">
  > = { get: jest.fn() };
  const swapProviderRegistry: jest.Mocked<Pick<SwapProviderRegistry, "get">> = {
    get: jest.fn(),
  };
  const prisma: {
    swapJob: {
      create: jest.MockedFunction<
        (args: object) => Promise<{ id: string; status: PrismaSwapStatus }>
      >;
      update: jest.MockedFunction<(args: object) => Promise<void>>;
    };
    $transaction: jest.MockedFunction<
      (
        callback: (tx: TransactionClientStub) => Promise<TransactionResult>,
      ) => Promise<TransactionResult>
    >;
  } = {
    swapJob: {
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const anthropicPlanningService: jest.Mocked<
    Pick<AnthropicPlanningService, "getPlannerMetadata" | "planTranches">
  > = {
    getPlannerMetadata: jest.fn(),
    planTranches: jest.fn(),
  };
  const swapPlanningPolicyService: jest.Mocked<
    Pick<SwapPlanningPolicyService, "resolve" | "buildInstantTranches">
  > = {
    resolve: jest.fn(),
    buildInstantTranches: jest.fn(),
  };
  const tranchePlanValidationService: jest.Mocked<
    Pick<TranchePlanValidationService, "validate">
  > = {
    validate: jest.fn(),
  };
  const tempWalletCryptoService: jest.Mocked<
    Pick<TempWalletCryptoService, "createEncryptedTempWallet">
  > = {
    createEncryptedTempWallet: jest.fn(),
  };
  const solanaService: jest.Mocked<
    Pick<SolanaService, "getPublicKey" | "signAndSendTransaction">
  > = {
    getPublicKey: jest.fn(),
    signAndSendTransaction: jest.fn(),
  };
  const swapExecutionService: jest.Mocked<
    Pick<SwapExecutionService, "markTrancheReadyForExecution">
  > = {
    markTrancheReadyForExecution: jest.fn(),
  };
  const swapProgressService: jest.Mocked<
    Pick<SwapProgressService, "getSwapSummary">
  > = {
    getSwapSummary: jest.fn(),
  };
  let plannerRunCreateMock: TransactionClientStub["swapPlannerRun"]["create"];
  let swapTrancheCreateMock: TransactionClientStub["swapTranche"]["create"];
  let swapTrancheUpdateManyMock: TransactionClientStub["swapTranche"]["updateMany"];
  let swapJobCreateInTransactionMock: TransactionClientStub["swapJob"]["create"];
  let swapJobUpdateMock: TransactionClientStub["swapJob"]["update"];

  beforeEach(() => {
    const prepareExecutionMock = jest.fn(async () => undefined);
    plannerRunCreateMock = jest.fn(async () => undefined);
    swapTrancheCreateMock = jest.fn(async () => ({ id: "tranche-id" }));
    swapTrancheUpdateManyMock = jest.fn(async () => ({ count: 1 }));
    swapJobCreateInTransactionMock = jest.fn(async () => ({ id: "swap-id" }));
    swapJobUpdateMock = jest.fn(async () => undefined);
    const fastPolicy: SwapPlanningPolicy = {
      executionMode: SwapExecutionMode.FAST,
      useClaude: true,
      singleTranche: false,
      requireImmediateFirstTranche: true,
      immediateStartWindowMs: 5000,
      maxAdjacentGapMs: 600000,
    };

    const custodyStrategy: CustodyProviderStrategy = {
      provider: CustodyProvider.MAGICBLOCK,
      deposit: jest.fn(async () => ({ transactionBase64: "deposit", raw: {} })),
      transfer: jest.fn(async () => ({
        transactionBase64: "transfer",
        raw: {},
      })),
      withdraw: jest.fn(async () => ({
        transactionBase64: "withdraw",
        raw: {},
      })),
      getPrivateBalance: jest.fn(async () => ({ balance: "1" })),
    };
    const swapStrategy: SwapProviderStrategy = {
      provider: SwapProvider.FLY,
      prepareExecution: prepareExecutionMock,
      markTrancheReady: jest.fn(async () => undefined),
    };

    jest.clearAllMocks();
    custodyProviderRegistry.get.mockReturnValue(custodyStrategy);
    swapProviderRegistry.get.mockReturnValue(swapStrategy);
    anthropicPlanningService.getPlannerMetadata.mockReturnValue({
      model: "claude-sonnet-4-20250514",
      promptVersion: "swap-tranche-planner-v3",
    });
    swapPlanningPolicyService.resolve.mockReturnValue(fastPolicy);
    swapPlanningPolicyService.buildInstantTranches.mockReturnValue([
      { amount: "10", executeAtUtc: "2026-04-21T12:00:05.000Z" },
    ]);
    prisma.swapJob.create.mockResolvedValue({
      id: "swap-id",
      status: PrismaSwapStatus.PLANNING,
    });
    prisma.swapJob.update.mockResolvedValue(undefined);
    anthropicPlanningService.planTranches.mockResolvedValue({
      model: "claude-sonnet-4-20250514",
      promptVersion: "swap-tranche-planner-v3",
      currentUtc: "2026-04-21T12:00:00.000Z",
      rawRequest: { foo: "bar" },
      rawResponse: { baz: "qux" },
      tranches: [
        { amount: "4", executeAtUtc: "2026-04-21T12:00:05.000Z" },
        { amount: "6", executeAtUtc: "2026-04-21T12:10:05.000Z" },
      ],
    });
    tranchePlanValidationService.validate.mockReturnValue([
      { amount: "4", executeAtUtc: "2026-04-21T12:00:05.000Z" },
      { amount: "6", executeAtUtc: "2026-04-21T12:10:05.000Z" },
    ]);
    tempWalletCryptoService.createEncryptedTempWallet.mockReturnValue({
      publicKey: "temp-wallet",
      encryptedSecret: "ciphertext",
      iv: "iv",
      authTag: "tag",
      algorithm: "aes-256-gcm",
    });
    solanaService.getPublicKey.mockReturnValue("owner-address");
    solanaService.signAndSendTransaction.mockResolvedValue(
      "source-deposit-sig",
    );
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        swapPlannerRun: { create: plannerRunCreateMock },
        swapTranche: {
          create: swapTrancheCreateMock,
          updateMany: swapTrancheUpdateManyMock,
        },
        swapJob: {
          create: swapJobCreateInTransactionMock,
          update: swapJobUpdateMock,
        },
      }),
    );
    swapExecutionService.markTrancheReadyForExecution.mockResolvedValue(
      undefined,
    );
    swapProgressService.getSwapSummary.mockResolvedValue({
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
  });

  it("creates a swap job, persists plan artifacts, and returns progress summary", async () => {
    const custodyProviderRegistryStub = Object.assign(
      Object.create(CustodyProviderRegistry.prototype),
      custodyProviderRegistry,
    ) as CustodyProviderRegistry;
    const swapProviderRegistryStub = Object.assign(
      Object.create(SwapProviderRegistry.prototype),
      swapProviderRegistry,
    ) as SwapProviderRegistry;
    const prismaStub = Object.assign(
      Object.create(PrismaService.prototype),
      prisma,
    ) as PrismaService;
    const anthropicPlanningServiceStub = Object.assign(
      Object.create(AnthropicPlanningService.prototype),
      anthropicPlanningService,
    ) as AnthropicPlanningService;
    const swapPlanningPolicyServiceStub = Object.assign(
      Object.create(SwapPlanningPolicyService.prototype),
      swapPlanningPolicyService,
    ) as SwapPlanningPolicyService;
    const tranchePlanValidationServiceStub = Object.assign(
      Object.create(TranchePlanValidationService.prototype),
      tranchePlanValidationService,
    ) as TranchePlanValidationService;
    const tempWalletCryptoServiceStub = Object.assign(
      Object.create(TempWalletCryptoService.prototype),
      tempWalletCryptoService,
    ) as TempWalletCryptoService;
    const solanaServiceStub = Object.assign(
      Object.create(SolanaService.prototype),
      solanaService,
    ) as SolanaService;
    const swapExecutionServiceStub = Object.assign(
      Object.create(SwapExecutionService.prototype),
      swapExecutionService,
    ) as SwapExecutionService;
    const swapProgressServiceStub = Object.assign(
      Object.create(SwapProgressService.prototype),
      swapProgressService,
    ) as SwapProgressService;

    const service = new SwapOrchestrationService(
      custodyProviderRegistryStub,
      swapProviderRegistryStub,
      prismaStub,
      anthropicPlanningServiceStub,
      swapPlanningPolicyServiceStub,
      tranchePlanValidationServiceStub,
      tempWalletCryptoServiceStub,
      solanaServiceStub,
      swapExecutionServiceStub,
      swapProgressServiceStub,
    );

    const result = await service.createSwap({
      custodyProvider: CustodyProvider.MAGICBLOCK,
      swapProvider: SwapProvider.FLY,
      executionMode: SwapExecutionMode.FAST,
      fromMint: "So11111111111111111111111111111111111111112",
      toMint: "So11111111111111111111111111111111111111112",
      fromAmount: "10",
      targetToAmount: "9",
      slippage: "0.005",
    });

    expect(custodyProviderRegistry.get).toHaveBeenCalledWith(
      CustodyProvider.MAGICBLOCK,
    );
    expect(swapProviderRegistry.get).toHaveBeenCalledWith(SwapProvider.FLY);
    expect(anthropicPlanningService.planTranches).toHaveBeenCalled();
    expect(swapPlanningPolicyService.resolve).toHaveBeenCalledWith(
      SwapExecutionMode.FAST,
    );
    expect(anthropicPlanningService.planTranches).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: SwapExecutionMode.FAST,
        fromAmount: "10",
      }),
      expect.objectContaining({
        executionMode: SwapExecutionMode.FAST,
        useClaude: true,
      }),
    );
    expect(tranchePlanValidationService.validate).not.toHaveBeenCalled();
    expect(
      tempWalletCryptoService.createEncryptedTempWallet,
    ).toHaveBeenCalledTimes(2);
    expect(solanaService.signAndSendTransaction).toHaveBeenCalledWith(
      "deposit",
    );
    expect(plannerRunCreateMock).toHaveBeenCalledTimes(1);
    expect(swapTrancheCreateMock).toHaveBeenCalledTimes(2);
    expect(swapProgressService.getSwapSummary).toHaveBeenCalledWith("swap-id");
    expect(result.id).toBe("swap-id");
  });

  it("records the last failed Claude planner attempt when planning exhausts retries", async () => {
    anthropicPlanningService.planTranches.mockRejectedValue(
      new AnthropicPlanningFailureException(
        "Anthropic planning failed after 10 attempts: Claude planner tranche amounts must sum to the requested source amount",
        {
          model: "claude-sonnet-4-20250514",
          promptVersion: "swap-tranche-planner-v3",
          currentUtc: "2026-04-21T12:00:00.000Z",
          rawRequest: { retry: 10 },
          rawResponse: { invalid: true },
        },
      ),
    );

    const custodyProviderRegistryStub = Object.assign(
      Object.create(CustodyProviderRegistry.prototype),
      custodyProviderRegistry,
    ) as CustodyProviderRegistry;
    const swapProviderRegistryStub = Object.assign(
      Object.create(SwapProviderRegistry.prototype),
      swapProviderRegistry,
    ) as SwapProviderRegistry;
    const prismaStub = Object.assign(
      Object.create(PrismaService.prototype),
      prisma,
    ) as PrismaService;
    const anthropicPlanningServiceStub = Object.assign(
      Object.create(AnthropicPlanningService.prototype),
      anthropicPlanningService,
    ) as AnthropicPlanningService;
    const swapPlanningPolicyServiceStub = Object.assign(
      Object.create(SwapPlanningPolicyService.prototype),
      swapPlanningPolicyService,
    ) as SwapPlanningPolicyService;
    const tranchePlanValidationServiceStub = Object.assign(
      Object.create(TranchePlanValidationService.prototype),
      tranchePlanValidationService,
    ) as TranchePlanValidationService;
    const tempWalletCryptoServiceStub = Object.assign(
      Object.create(TempWalletCryptoService.prototype),
      tempWalletCryptoService,
    ) as TempWalletCryptoService;
    const solanaServiceStub = Object.assign(
      Object.create(SolanaService.prototype),
      solanaService,
    ) as SolanaService;
    const swapExecutionServiceStub = Object.assign(
      Object.create(SwapExecutionService.prototype),
      swapExecutionService,
    ) as SwapExecutionService;
    const swapProgressServiceStub = Object.assign(
      Object.create(SwapProgressService.prototype),
      swapProgressService,
    ) as SwapProgressService;

    const service = new SwapOrchestrationService(
      custodyProviderRegistryStub,
      swapProviderRegistryStub,
      prismaStub,
      anthropicPlanningServiceStub,
      swapPlanningPolicyServiceStub,
      tranchePlanValidationServiceStub,
      tempWalletCryptoServiceStub,
      solanaServiceStub,
      swapExecutionServiceStub,
      swapProgressServiceStub,
    );

    await expect(
      service.createSwap({
        custodyProvider: CustodyProvider.MAGICBLOCK,
        swapProvider: SwapProvider.FLY,
        executionMode: SwapExecutionMode.FAST,
        fromMint: "So11111111111111111111111111111111111111112",
        toMint: "So11111111111111111111111111111111111111112",
        fromAmount: "10",
        targetToAmount: "9",
        slippage: "0.005",
      }),
    ).rejects.toThrow(
      "Anthropic planning failed after 10 attempts: Claude planner tranche amounts must sum to the requested source amount",
    );

    expect(plannerRunCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: "claude-sonnet-4-20250514",
        rawRequestJson: { retry: 10 },
        rawResponseJson: { invalid: true },
        validationSucceeded: false,
        errorMessage:
          "Anthropic planning failed after 10 attempts: Claude planner tranche amounts must sum to the requested source amount",
      }),
    });
  });

  it("creates a single immediate tranche for instant mode without calling Anthropic", async () => {
    const instantPolicy: SwapPlanningPolicy = {
      executionMode: SwapExecutionMode.INSTANT,
      useClaude: false,
      singleTranche: true,
      requireImmediateFirstTranche: true,
      immediateStartWindowMs: 5000,
    };
    swapPlanningPolicyService.resolve.mockReturnValue(instantPolicy);
    tranchePlanValidationService.validate.mockReturnValue([
      { amount: "10", executeAtUtc: "2026-04-21T12:00:05.000Z" },
    ]);
    swapProgressService.getSwapSummary.mockResolvedValue({
      id: "swap-id",
      custodyProvider: CustodyProvider.MAGICBLOCK,
      swapProvider: SwapProvider.FLY,
      executionMode: SwapExecutionMode.INSTANT,
      fromMint: "So11111111111111111111111111111111111111112",
      toMint: "So11111111111111111111111111111111111111112",
      fromAmount: "10",
      targetToAmount: "0",
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

    const custodyProviderRegistryStub = Object.assign(
      Object.create(CustodyProviderRegistry.prototype),
      custodyProviderRegistry,
    ) as CustodyProviderRegistry;
    const swapProviderRegistryStub = Object.assign(
      Object.create(SwapProviderRegistry.prototype),
      swapProviderRegistry,
    ) as SwapProviderRegistry;
    const prismaStub = Object.assign(
      Object.create(PrismaService.prototype),
      prisma,
    ) as PrismaService;
    const anthropicPlanningServiceStub = Object.assign(
      Object.create(AnthropicPlanningService.prototype),
      anthropicPlanningService,
    ) as AnthropicPlanningService;
    const swapPlanningPolicyServiceStub = Object.assign(
      Object.create(SwapPlanningPolicyService.prototype),
      swapPlanningPolicyService,
    ) as SwapPlanningPolicyService;
    const tranchePlanValidationServiceStub = Object.assign(
      Object.create(TranchePlanValidationService.prototype),
      tranchePlanValidationService,
    ) as TranchePlanValidationService;
    const tempWalletCryptoServiceStub = Object.assign(
      Object.create(TempWalletCryptoService.prototype),
      tempWalletCryptoService,
    ) as TempWalletCryptoService;
    const solanaServiceStub = Object.assign(
      Object.create(SolanaService.prototype),
      solanaService,
    ) as SolanaService;
    const swapExecutionServiceStub = Object.assign(
      Object.create(SwapExecutionService.prototype),
      swapExecutionService,
    ) as SwapExecutionService;
    const swapProgressServiceStub = Object.assign(
      Object.create(SwapProgressService.prototype),
      swapProgressService,
    ) as SwapProgressService;

    const service = new SwapOrchestrationService(
      custodyProviderRegistryStub,
      swapProviderRegistryStub,
      prismaStub,
      anthropicPlanningServiceStub,
      swapPlanningPolicyServiceStub,
      tranchePlanValidationServiceStub,
      tempWalletCryptoServiceStub,
      solanaServiceStub,
      swapExecutionServiceStub,
      swapProgressServiceStub,
    );

    await expect(
      service.createSwap({
        custodyProvider: CustodyProvider.MAGICBLOCK,
        swapProvider: SwapProvider.FLY,
        executionMode: SwapExecutionMode.INSTANT,
        fromMint: "So11111111111111111111111111111111111111112",
        toMint: "So11111111111111111111111111111111111111112",
        fromAmount: "10",
        targetToAmount: "9",
        slippage: "0.005",
      }),
    ).rejects.toThrow(BadRequestException);

    expect(anthropicPlanningService.planTranches).not.toHaveBeenCalled();
    expect(
      swapPlanningPolicyService.buildInstantTranches,
    ).not.toHaveBeenCalled();
    expect(plannerRunCreateMock).not.toHaveBeenCalled();
    expect(swapTrancheCreateMock).not.toHaveBeenCalled();
  });

  it("creates and executes an instant swap with a fresh provider quote", async () => {
    const instantPolicy: SwapPlanningPolicy = {
      executionMode: SwapExecutionMode.INSTANT,
      useClaude: false,
      singleTranche: true,
      requireImmediateFirstTranche: true,
      immediateStartWindowMs: 5000,
    };
    swapPlanningPolicyService.resolve.mockReturnValue(instantPolicy);
    tranchePlanValidationService.validate.mockReturnValue([
      { amount: "10", executeAtUtc: "2026-04-21T12:00:05.000Z" },
    ]);
    swapProgressService.getSwapSummary.mockResolvedValue({
      id: "swap-id",
      custodyProvider: CustodyProvider.MAGICBLOCK,
      swapProvider: SwapProvider.FLY,
      executionMode: SwapExecutionMode.INSTANT,
      fromMint: "So11111111111111111111111111111111111111112",
      toMint: "So11111111111111111111111111111111111111112",
      fromAmount: "10",
      targetToAmount: "9",
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

    const custodyProviderRegistryStub = Object.assign(
      Object.create(CustodyProviderRegistry.prototype),
      custodyProviderRegistry,
    ) as CustodyProviderRegistry;
    const swapProviderRegistryStub = Object.assign(
      Object.create(SwapProviderRegistry.prototype),
      swapProviderRegistry,
    ) as SwapProviderRegistry;
    const prismaStub = Object.assign(
      Object.create(PrismaService.prototype),
      prisma,
    ) as PrismaService;
    const anthropicPlanningServiceStub = Object.assign(
      Object.create(AnthropicPlanningService.prototype),
      anthropicPlanningService,
    ) as AnthropicPlanningService;
    const swapPlanningPolicyServiceStub = Object.assign(
      Object.create(SwapPlanningPolicyService.prototype),
      swapPlanningPolicyService,
    ) as SwapPlanningPolicyService;
    const tranchePlanValidationServiceStub = Object.assign(
      Object.create(TranchePlanValidationService.prototype),
      tranchePlanValidationService,
    ) as TranchePlanValidationService;
    const tempWalletCryptoServiceStub = Object.assign(
      Object.create(TempWalletCryptoService.prototype),
      tempWalletCryptoService,
    ) as TempWalletCryptoService;
    const solanaServiceStub = Object.assign(
      Object.create(SolanaService.prototype),
      solanaService,
    ) as SolanaService;
    const swapExecutionServiceStub = Object.assign(
      Object.create(SwapExecutionService.prototype),
      swapExecutionService,
    ) as SwapExecutionService;
    const swapProgressServiceStub = Object.assign(
      Object.create(SwapProgressService.prototype),
      swapProgressService,
    ) as SwapProgressService;

    const service = new SwapOrchestrationService(
      custodyProviderRegistryStub,
      swapProviderRegistryStub,
      prismaStub,
      anthropicPlanningServiceStub,
      swapPlanningPolicyServiceStub,
      tranchePlanValidationServiceStub,
      tempWalletCryptoServiceStub,
      solanaServiceStub,
      swapExecutionServiceStub,
      swapProgressServiceStub,
    );

    await service.createInstantSwap({
      custodyProvider: CustodyProvider.MAGICBLOCK,
      swapProvider: SwapProvider.FLY,
      fromMint: "So11111111111111111111111111111111111111112",
      toMint: "So11111111111111111111111111111111111111112",
      fromAmount: "10",
      slippage: "0.005",
    });

    expect(anthropicPlanningService.planTranches).not.toHaveBeenCalled();
    expect(swapPlanningPolicyService.buildInstantTranches).toHaveBeenCalledWith(
      "10",
      expect.any(String),
    );
    expect(plannerRunCreateMock).not.toHaveBeenCalled();
    expect(swapTrancheCreateMock).toHaveBeenCalledTimes(1);
    expect(solanaService.signAndSendTransaction).toHaveBeenCalledWith(
      "deposit",
    );
    expect(
      swapExecutionService.markTrancheReadyForExecution,
    ).toHaveBeenCalledWith("tranche-id");
  });
});
