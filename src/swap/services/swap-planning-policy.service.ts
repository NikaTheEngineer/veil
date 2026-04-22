import { Injectable } from "@nestjs/common";

import type { ClaudePlannedTranche } from "../../ai-planning/anthropic-planning.service.js";
import type { TranchePlanValidationPolicy } from "../../ai-planning/tranche-plan-validation.service.js";
import { SwapExecutionMode } from "../../common/enums/swap-execution-mode.enum.js";

const DEFAULT_SCHEDULER_INTERVAL_MS = 5000;
const FAST_MAX_ADJACENT_GAP_MS = 10 * 60 * 1000;
const SECURE_MAX_TOTAL_WINDOW_MS = 3 * 60 * 60 * 1000;

export interface SwapPlanningPolicy extends TranchePlanValidationPolicy {
  useClaude: boolean;
}

@Injectable()
export class SwapPlanningPolicyService {
  resolve(executionMode: SwapExecutionMode): SwapPlanningPolicy {
    const immediateStartWindowMs = this.getSchedulerIntervalMs();

    switch (executionMode) {
      case SwapExecutionMode.INSTANT:
        return {
          executionMode,
          useClaude: false,
          singleTranche: true,
          requireImmediateFirstTranche: true,
          immediateStartWindowMs,
        };
      case SwapExecutionMode.FAST:
        return {
          executionMode,
          useClaude: true,
          singleTranche: false,
          requireImmediateFirstTranche: true,
          immediateStartWindowMs,
          maxAdjacentGapMs: FAST_MAX_ADJACENT_GAP_MS,
        };
      case SwapExecutionMode.SECURE:
        return {
          executionMode,
          useClaude: true,
          singleTranche: false,
          requireImmediateFirstTranche: true,
          immediateStartWindowMs,
          maxTotalWindowMs: SECURE_MAX_TOTAL_WINDOW_MS,
        };
    }
  }

  buildInstantTranches(
    fromAmount: string,
    currentUtc: string,
  ): ClaudePlannedTranche[] {
    return [
      {
        amount: fromAmount,
        executeAtUtc: new Date(
          Date.parse(currentUtc) + this.getSchedulerIntervalMs(),
        ).toISOString(),
      },
    ];
  }

  private getSchedulerIntervalMs(): number {
    const parsed = Number(process.env.SWAP_SCHEDULER_INTERVAL_MS ?? "5000");

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_SCHEDULER_INTERVAL_MS;
    }

    return parsed;
  }
}
