import { BadRequestException, Injectable } from "@nestjs/common";
import { type Prisma, SwapStatus, SwapTrancheStatus } from "@prisma/client";

import {
  AnthropicPlanningFailureException,
  AnthropicPlanningService,
  type ClaudePlannedTranche,
  type PlanSwapTranchesResult,
} from "../../ai-planning/anthropic-planning.service.js";
import { TranchePlanValidationService } from "../../ai-planning/tranche-plan-validation.service.js";
import { SwapExecutionMode } from "../../common/enums/swap-execution-mode.enum.js";
import type { JsonValue } from "../../common/types/json-value.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { CustodyProviderRegistry } from "../../wallet/providers/custody-provider.registry.js";
import { SwapProviderRegistry } from "../../wallet/providers/swap-provider.registry.js";
import { SolanaService } from "../../wallet/solana.service.js";
import type { CreateInstantSwapDto } from "../dto/create-instant-swap.dto.js";
import type { CreateSwapDto } from "../dto/create-swap.dto.js";
import type { SwapJobSummaryResponse } from "../interfaces/swap-response.js";
import { SwapExecutionService } from "./swap-execution.service.js";
import type { SwapPlanningPolicy } from "./swap-planning-policy.service.js";
import { SwapPlanningPolicyService } from "./swap-planning-policy.service.js";
import { SwapProgressService } from "./swap-progress.service.js";
import { TempWalletCryptoService } from "./temp-wallet-crypto.service.js";

@Injectable()
export class SwapOrchestrationService {
  private readonly instantPlannerModel = "DIRECT_INSTANT_SWAP";
  private readonly instantPromptVersion = "instant-quote-v1";

  constructor(
    private readonly custodyProviderRegistry: CustodyProviderRegistry,
    private readonly swapProviderRegistry: SwapProviderRegistry,
    private readonly prisma: PrismaService,
    private readonly anthropicPlanningService: AnthropicPlanningService,
    private readonly swapPlanningPolicyService: SwapPlanningPolicyService,
    private readonly tranchePlanValidationService: TranchePlanValidationService,
    private readonly tempWalletCryptoService: TempWalletCryptoService,
    private readonly solanaService: SolanaService,
    private readonly swapExecutionService: SwapExecutionService,
    private readonly swapProgressService: SwapProgressService,
  ) {}

  async createSwap(dto: CreateSwapDto): Promise<SwapJobSummaryResponse> {
    if (dto.executionMode === SwapExecutionMode.INSTANT) {
      throw new BadRequestException(
        "Instant swaps must use POST /swap/instant with a pre-fetched Fly quote id",
      );
    }

    this.custodyProviderRegistry.get(dto.custodyProvider);
    const swapStrategy = this.swapProviderRegistry.get(dto.swapProvider);
    const plannerMetadata = this.anthropicPlanningService.getPlannerMetadata();
    const initialCurrentUtc = new Date().toISOString();
    const planningPolicy = this.swapPlanningPolicyService.resolve(
      dto.executionMode,
    );

    const swapJob = await this.prisma.swapJob.create({
      data: {
        custodyProvider: dto.custodyProvider,
        swapProvider: dto.swapProvider,
        executionMode: dto.executionMode,
        fromMint: dto.fromMint,
        toMint: dto.toMint,
        fromAmount: dto.fromAmount,
        targetToAmount: dto.targetToAmount,
        slippage: dto.slippage,
        status: SwapStatus.PLANNING,
        plannerModel: plannerMetadata.model,
        plannerPromptVersion: plannerMetadata.promptVersion,
        planningCurrentUtc: new Date(initialCurrentUtc),
        plannedFromAmount: dto.fromAmount,
        swappedFromAmount: "0",
        remainingFromAmount: dto.fromAmount,
        totalTranches: 0,
        readyTranches: 0,
        fundedTranches: 0,
        submittedSwapTranches: 0,
        depositedTranches: 0,
        failedTranches: 0,
      },
    });

    let planningResult: PlanSwapTranchesResult | undefined;

    try {
      await swapStrategy.prepareExecution({
        swapJobId: swapJob.id,
        custodyProvider: dto.custodyProvider,
        swapProvider: dto.swapProvider,
        executionMode: dto.executionMode,
        fromMint: dto.fromMint,
        toMint: dto.toMint,
        fromAmount: dto.fromAmount,
        targetToAmount: dto.targetToAmount,
        slippage: dto.slippage,
      });

      const plannedTranches = planningPolicy.useClaude
        ? await this.planClaudeTranches(dto, planningPolicy)
        : {
            planningResult: undefined,
            tranches: this.tranchePlanValidationService.validate(
              this.swapPlanningPolicyService.buildInstantTranches(
                dto.fromAmount,
                initialCurrentUtc,
              ),
              dto.fromAmount,
              initialCurrentUtc,
              planningPolicy,
            ),
          };
      planningResult = plannedTranches.planningResult;
      const validatedTranches = plannedTranches.tranches;

      await this.prisma.$transaction(async (tx) => {
        if (planningResult) {
          await tx.swapPlannerRun.create({
            data: {
              swapJobId: swapJob.id,
              model: planningResult.model,
              rawRequestJson: this.toJsonValue(planningResult.rawRequest),
              rawResponseJson: this.toJsonValue(planningResult.rawResponse),
              validationSucceeded: true,
            },
          });
        }

        for (const [index, tranche] of validatedTranches.entries()) {
          const tempWallet =
            this.tempWalletCryptoService.createEncryptedTempWallet();

          await tx.swapTranche.create({
            data: {
              swapJobId: swapJob.id,
              sequence: index + 1,
              plannedAmount: tranche.amount,
              executeAtUtc: new Date(tranche.executeAtUtc),
              tempWalletPublicKey: tempWallet.publicKey,
              encryptedTempWalletSecret: tempWallet.encryptedSecret,
              tempWalletEncryptionIv: tempWallet.iv,
              tempWalletEncryptionAuthTag: tempWallet.authTag,
              tempWalletEncryptionAlgorithm: tempWallet.algorithm,
              status: SwapTrancheStatus.ADDRESS_GENERATED,
              statusReason: "Temporary wallet generated and persisted",
            },
          });
        }

        await tx.swapJob.update({
          where: { id: swapJob.id },
          data: {
            plannerModel: planningResult?.model ?? plannerMetadata.model,
            plannerPromptVersion:
              planningResult?.promptVersion ?? plannerMetadata.promptVersion,
            planningCurrentUtc: new Date(
              planningResult?.currentUtc ?? initialCurrentUtc,
            ),
            totalTranches: validatedTranches.length,
          },
        });
      });

      const sourceDepositSignature = await this.depositSourceFundsIntoCustody(
        dto.custodyProvider,
        dto.fromMint,
        dto.fromAmount,
      );
      await this.prisma.swapJob.update({
        where: { id: swapJob.id },
        data: {
          status: SwapStatus.PLANNED,
          sourceDepositSignature,
        },
      });

      return this.swapProgressService.getSwapSummary(swapJob.id);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : String(error);
      const failedPlanningResult =
        error instanceof AnthropicPlanningFailureException
          ? {
              ...error.attempt,
              rawResponse: error.attempt.rawResponse,
            }
          : planningResult;
      await this.recordFailure(
        swapJob.id,
        plannerMetadata.model,
        failedPlanningResult,
        normalizedError,
      );
      throw error;
    }
  }

  async createInstantSwap(
    dto: CreateInstantSwapDto,
  ): Promise<SwapJobSummaryResponse> {
    this.custodyProviderRegistry.get(dto.custodyProvider);
    const swapStrategy = this.swapProviderRegistry.get(dto.swapProvider);
    const planningPolicy = this.swapPlanningPolicyService.resolve(
      SwapExecutionMode.INSTANT,
    );
    const initialCurrentUtc = new Date().toISOString();
    let swapJobId: string | undefined;

    try {
      await swapStrategy.prepareExecution({
        swapJobId: "instant-pending",
        custodyProvider: dto.custodyProvider,
        swapProvider: dto.swapProvider,
        executionMode: SwapExecutionMode.INSTANT,
        fromMint: dto.fromMint,
        toMint: dto.toMint,
        fromAmount: dto.fromAmount,
        targetToAmount: dto.targetToAmount,
        slippage: dto.slippage,
      });

      const validatedTranches = this.tranchePlanValidationService.validate(
        this.swapPlanningPolicyService.buildInstantTranches(
          dto.fromAmount,
          initialCurrentUtc,
        ),
        dto.fromAmount,
        initialCurrentUtc,
        planningPolicy,
      );
      const [tranchePlan] = validatedTranches;
      const tempWallet =
        this.tempWalletCryptoService.createEncryptedTempWallet();

      const created = await this.prisma.$transaction(async (tx) => {
        const swapJob = await tx.swapJob.create({
          data: {
            custodyProvider: dto.custodyProvider,
            swapProvider: dto.swapProvider,
            executionMode: SwapExecutionMode.INSTANT,
            fromMint: dto.fromMint,
            toMint: dto.toMint,
            fromAmount: dto.fromAmount,
            targetToAmount: dto.targetToAmount,
            slippage: dto.slippage,
            status: SwapStatus.PLANNING,
            plannerModel: this.instantPlannerModel,
            plannerPromptVersion: this.instantPromptVersion,
            planningCurrentUtc: new Date(initialCurrentUtc),
            plannedFromAmount: dto.fromAmount,
            swappedFromAmount: "0",
            remainingFromAmount: dto.fromAmount,
            totalTranches: 0,
            readyTranches: 0,
            fundedTranches: 0,
            submittedSwapTranches: 0,
            depositedTranches: 0,
            failedTranches: 0,
          },
        });

        const tranche = await tx.swapTranche.create({
          data: {
            swapJobId: swapJob.id,
            sequence: 1,
            plannedAmount: tranchePlan.amount,
            executeAtUtc: new Date(tranchePlan.executeAtUtc),
            tempWalletPublicKey: tempWallet.publicKey,
            encryptedTempWalletSecret: tempWallet.encryptedSecret,
            tempWalletEncryptionIv: tempWallet.iv,
            tempWalletEncryptionAuthTag: tempWallet.authTag,
            tempWalletEncryptionAlgorithm: tempWallet.algorithm,
            status: SwapTrancheStatus.ADDRESS_GENERATED,
            statusReason: "Temporary wallet generated and persisted",
          },
        });

        await tx.swapJob.update({
          where: { id: swapJob.id },
          data: {
            totalTranches: 1,
          },
        });

        return {
          swapJobId: swapJob.id,
          trancheId: tranche.id,
        };
      });
      swapJobId = created.swapJobId;

      const sourceDepositSignature = await this.depositSourceFundsIntoCustody(
        dto.custodyProvider,
        dto.fromMint,
        dto.fromAmount,
      );
      await this.prisma.swapJob.update({
        where: { id: created.swapJobId },
        data: {
          status: SwapStatus.PLANNED,
          sourceDepositSignature,
        },
      });

      await this.swapExecutionService.markTrancheReadyForExecution(
        created.trancheId,
        {
          quoteId: dto.quoteId,
          amountOut: dto.amountOut,
        },
      );

      return this.swapProgressService.getSwapSummary(created.swapJobId);
    } catch (error) {
      if (swapJobId) {
        const normalizedError = error instanceof Error ? error : String(error);
        await this.recordFailure(
          swapJobId,
          this.instantPlannerModel,
          undefined,
          normalizedError,
        );
      }
      throw error;
    }
  }

  private async recordFailure(
    swapJobId: string,
    fallbackModel: string,
    planningResult:
      | PlanSwapTranchesResult
      | {
          model: string;
          promptVersion: string;
          currentUtc: string;
          rawRequest: JsonValue;
          rawResponse: JsonValue | null;
        }
      | undefined,
    error: Error | string,
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : error;

    try {
      await this.prisma.$transaction(async (tx) => {
        if (planningResult) {
          await tx.swapPlannerRun.create({
            data: {
              swapJobId,
              model: planningResult.model,
              rawRequestJson: this.toJsonValue(planningResult.rawRequest),
              rawResponseJson: this.toJsonValue(planningResult.rawResponse),
              validationSucceeded: false,
              errorMessage,
            },
          });
        }

        await tx.swapJob.update({
          where: { id: swapJobId },
          data: {
            status: SwapStatus.FAILED,
            plannerModel: planningResult?.model ?? fallbackModel,
          },
        });
        await tx.swapTranche.updateMany({
          where: {
            swapJobId,
            status: SwapTrancheStatus.ADDRESS_GENERATED,
          },
          data: {
            status: SwapTrancheStatus.FAILED,
            statusReason: "Swap setup failed before execution",
            lastError: errorMessage,
          },
        });
      });
    } catch (recordFailureError) {
      const detail =
        recordFailureError instanceof Error
          ? recordFailureError.message
          : String(recordFailureError);
      throw new BadRequestException(
        `Swap planning failed and failure state could not be persisted: ${detail}`,
      );
    }
  }

  private toJsonValue(value: JsonValue): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private async planClaudeTranches(
    dto: CreateSwapDto,
    planningPolicy: SwapPlanningPolicy,
  ): Promise<{
    planningResult: PlanSwapTranchesResult;
    tranches: ClaudePlannedTranche[];
  }> {
    const planningResult = await this.anthropicPlanningService.planTranches(
      {
        custodyProvider: dto.custodyProvider,
        swapProvider: dto.swapProvider,
        executionMode: dto.executionMode,
        fromMint: dto.fromMint,
        toMint: dto.toMint,
        fromAmount: dto.fromAmount,
        targetToAmount: dto.targetToAmount,
        immediateStartWindowMs: planningPolicy.immediateStartWindowMs,
        maxAdjacentGapMs: planningPolicy.maxAdjacentGapMs,
        maxTotalWindowMs: planningPolicy.maxTotalWindowMs,
      },
      planningPolicy,
    );

    return {
      planningResult,
      tranches: planningResult.tranches,
    };
  }

  private async depositSourceFundsIntoCustody(
    custodyProvider: CreateSwapDto["custodyProvider"],
    mint: string,
    amount: string,
  ): Promise<string> {
    const custodyStrategy = this.custodyProviderRegistry.get(custodyProvider);
    const owner = this.solanaService.getPublicKey();
    const depositPayload = await custodyStrategy.deposit({
      owner,
      mint,
      amount,
    });

    return this.solanaService.signAndSendTransaction(
      depositPayload.transactionBase64,
    );
  }
}
