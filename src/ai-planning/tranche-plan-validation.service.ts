import { BadRequestException, Injectable } from "@nestjs/common";

import { SwapExecutionMode } from "../common/enums/swap-execution-mode.enum.js";
import type { JsonObject, JsonValue } from "../common/types/json-value.js";
import type { ClaudePlannedTranche } from "./anthropic-planning.service.js";

export interface TranchePlanValidationPolicy {
  executionMode: SwapExecutionMode;
  singleTranche: boolean;
  requireImmediateFirstTranche: boolean;
  immediateStartWindowMs: number;
  maxAdjacentGapMs?: number;
  maxTotalWindowMs?: number;
}

@Injectable()
export class TranchePlanValidationService {
  validate(
    tranches: JsonValue | ClaudePlannedTranche[],
    expectedFromAmount: string,
    currentUtc: string,
    policy: TranchePlanValidationPolicy,
  ): ClaudePlannedTranche[] {
    if (!Array.isArray(tranches) || tranches.length === 0) {
      throw new BadRequestException(
        "Claude planner returned an empty tranche array",
      );
    }

    const normalizedTranches = tranches.map((tranche, index) =>
      this.normalizeTranche(tranche, index, currentUtc),
    );
    const planningTimeMs = Date.parse(currentUtc);

    let total = 0n;
    let previousTime = 0;
    const seenTimes = new Set<string>();

    if (policy.singleTranche && normalizedTranches.length !== 1) {
      throw new BadRequestException(
        "Instant execution mode must produce exactly one tranche",
      );
    }

    if (!policy.singleTranche && normalizedTranches.length < 2) {
      throw new BadRequestException(
        `${policy.executionMode} execution mode must produce at least two tranches`,
      );
    }

    for (const tranche of normalizedTranches) {
      total += BigInt(tranche.amount);

      const executeAtMs = Date.parse(tranche.executeAtUtc);
      if (seenTimes.has(tranche.executeAtUtc)) {
        throw new BadRequestException(
          "Claude planner returned duplicate UTC timestamps",
        );
      }

      if (executeAtMs <= previousTime) {
        throw new BadRequestException(
          "Claude planner must return tranche timestamps in strictly increasing order",
        );
      }

      if (previousTime > 0 && policy.maxAdjacentGapMs) {
        const gapMs = executeAtMs - previousTime;
        if (gapMs > policy.maxAdjacentGapMs) {
          throw new BadRequestException(
            `${policy.executionMode} execution mode requires adjacent tranche gaps to stay within the allowed window`,
          );
        }
      }

      seenTimes.add(tranche.executeAtUtc);
      previousTime = executeAtMs;
    }

    if (total !== BigInt(expectedFromAmount)) {
      throw new BadRequestException(
        "Claude planner tranche amounts must sum to the requested source amount",
      );
    }

    const [firstTranche] = normalizedTranches;
    const lastTranche = normalizedTranches.at(-1);

    if (
      policy.requireImmediateFirstTranche &&
      Date.parse(firstTranche.executeAtUtc) >
        planningTimeMs + policy.immediateStartWindowMs
    ) {
      throw new BadRequestException(
        `${policy.executionMode} execution mode requires the first tranche to start immediately`,
      );
    }

    if (
      lastTranche &&
      policy.maxTotalWindowMs &&
      Date.parse(lastTranche.executeAtUtc) - planningTimeMs >
        policy.maxTotalWindowMs
    ) {
      throw new BadRequestException(
        `${policy.executionMode} execution mode exceeds the maximum schedule window`,
      );
    }

    return normalizedTranches;
  }

  private normalizeTranche(
    tranche: JsonValue | ClaudePlannedTranche,
    index: number,
    currentUtc: string,
  ): ClaudePlannedTranche {
    if (!this.isRecord(tranche)) {
      throw new BadRequestException(
        `Claude planner tranche at index ${index} must be an object`,
      );
    }

    const keys = Object.keys(tranche);
    if (
      keys.length !== 2 ||
      !keys.includes("amount") ||
      !keys.includes("executeAtUtc")
    ) {
      throw new BadRequestException(
        `Claude planner tranche at index ${index} must contain only amount and executeAtUtc`,
      );
    }

    const amount = tranche.amount;
    const executeAtUtc = tranche.executeAtUtc;

    if (typeof amount !== "string" || !/^(0|[1-9]\d*)$/.test(amount)) {
      throw new BadRequestException(
        `Claude planner tranche at index ${index} has an invalid atomic amount`,
      );
    }

    if (typeof executeAtUtc !== "string" || !executeAtUtc.endsWith("Z")) {
      throw new BadRequestException(
        `Claude planner tranche at index ${index} must use a UTC ISO timestamp`,
      );
    }

    const parsedTime = Date.parse(executeAtUtc);

    if (Number.isNaN(parsedTime)) {
      throw new BadRequestException(
        `Claude planner tranche at index ${index} has an invalid UTC timestamp`,
      );
    }

    const normalizedExecuteAtUtc = new Date(parsedTime).toISOString();

    if (parsedTime <= Date.parse(currentUtc)) {
      throw new BadRequestException(
        `Claude planner tranche at index ${index} must be scheduled in the future`,
      );
    }

    return {
      amount,
      executeAtUtc: normalizedExecuteAtUtc,
    };
  }

  private isRecord(
    value: JsonValue | ClaudePlannedTranche,
  ): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
