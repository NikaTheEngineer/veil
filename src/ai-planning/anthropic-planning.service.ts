import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";

import { SwapExecutionMode } from "../common/enums/swap-execution-mode.enum.js";
import type { JsonObject, JsonValue } from "../common/types/json-value.js";
import {
  type TranchePlanValidationPolicy,
  TranchePlanValidationService,
} from "./tranche-plan-validation.service.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const PROMPT_VERSION = "swap-tranche-planner-v3";
const TOOL_NAME = "record_swap_tranches";
const MAX_PLANNER_ATTEMPTS = 10;

export interface ClaudePlannedTranche {
  amount: string;
  executeAtUtc: string;
}

export interface PlanSwapTranchesInput {
  custodyProvider: string;
  swapProvider: string;
  executionMode: SwapExecutionMode;
  fromMint: string;
  toMint: string;
  fromAmount: string;
  targetToAmount: string;
  immediateStartWindowMs: number;
  maxAdjacentGapMs?: number;
  maxTotalWindowMs?: number;
}

export interface PlanSwapTranchesResult {
  model: string;
  promptVersion: string;
  currentUtc: string;
  rawRequest: JsonValue;
  rawResponse: JsonValue;
  tranches: ClaudePlannedTranche[];
}

export interface AnthropicPlanningAttemptContext {
  model: string;
  promptVersion: string;
  currentUtc: string;
  rawRequest: JsonValue;
  rawResponse: JsonValue | null;
}

type AnthropicToolUseBlock = JsonObject & {
  type: string;
  name: string;
  input?: JsonObject;
};

type AnthropicMessageResponse = JsonObject & {
  content?: JsonValue[];
};

class RetryablePlannerResponseError extends Error {
  constructor(
    message: string,
    readonly rawResponse: JsonValue | null,
  ) {
    super(message);
  }
}

export class AnthropicPlanningFailureException extends BadGatewayException {
  constructor(
    message: string,
    readonly attempt: AnthropicPlanningAttemptContext,
  ) {
    super(message);
  }
}

@Injectable()
export class AnthropicPlanningService {
  constructor(
    private readonly tranchePlanValidationService: TranchePlanValidationService,
  ) {}

  getPlannerMetadata(): { model: string; promptVersion: string } {
    return {
      model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
      promptVersion: PROMPT_VERSION,
    };
  }

  async planTranches(
    input: PlanSwapTranchesInput,
    policy: TranchePlanValidationPolicy,
  ): Promise<PlanSwapTranchesResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

    if (!apiKey) {
      throw new InternalServerErrorException(
        "Missing required environment variable: ANTHROPIC_API_KEY",
      );
    }

    const currentUtc = new Date().toISOString();
    const { model, promptVersion } = this.getPlannerMetadata();
    let failureDetail: string | undefined;
    let previousResponse: JsonValue | null = null;

    for (
      let attemptNumber = 1;
      attemptNumber <= MAX_PLANNER_ATTEMPTS;
      attemptNumber += 1
    ) {
      const requestBody = this.buildRequestBody(
        model,
        input,
        policy,
        currentUtc,
        failureDetail,
        previousResponse,
      );

      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(requestBody),
        });

        const responseText = await response.text();

        if (!response.ok) {
          throw new AnthropicPlanningFailureException(
            `Anthropic planning request failed with HTTP ${response.status}: ${responseText.slice(0, 1000)}`,
            {
              model,
              promptVersion,
              currentUtc,
              rawRequest: requestBody,
              rawResponse: responseText,
            },
          );
        }

        const parsedResponse = this.parseResponse(responseText);
        const tranches = this.extractTranches(parsedResponse);
        const validatedTranches = this.validateTranches(
          tranches,
          parsedResponse,
          input.fromAmount,
          currentUtc,
          policy,
        );

        return {
          model,
          promptVersion,
          currentUtc,
          rawRequest: requestBody,
          rawResponse: parsedResponse,
          tranches: validatedTranches,
        };
      } catch (error) {
        if (error instanceof AnthropicPlanningFailureException) {
          throw error;
        }

        const retryableFailure = this.toRetryableFailure(error);
        if (!retryableFailure) {
          throw error;
        }

        failureDetail = retryableFailure.message;
        previousResponse = retryableFailure.rawResponse;

        if (attemptNumber === MAX_PLANNER_ATTEMPTS) {
          throw new AnthropicPlanningFailureException(
            `Anthropic planning failed after ${MAX_PLANNER_ATTEMPTS} attempts: ${failureDetail}`,
            {
              model,
              promptVersion,
              currentUtc,
              rawRequest: requestBody,
              rawResponse: previousResponse,
            },
          );
        }
      }
    }

    throw new BadGatewayException("Anthropic planning failed unexpectedly");
  }

  private buildPrompt(
    input: PlanSwapTranchesInput,
    currentUtc: string,
    policy: TranchePlanValidationPolicy,
    failureDetail?: string,
    previousResponse?: JsonValue | null,
  ): string {
    const promptLines = [
      "Create a JSON-only tranche schedule for a token swap.",
      `Current UTC: ${currentUtc}`,
      `Execution mode: ${input.executionMode}`,
      `Custody provider: ${input.custodyProvider}`,
      `Future swap provider: ${input.swapProvider}`,
      `From mint: ${input.fromMint}`,
      `To mint: ${input.toMint}`,
      `From amount (atomic units): ${input.fromAmount}`,
      `Target to amount (planning context only, atomic units): ${input.targetToAmount}`,
      `The first tranche must execute no later than ${policy.immediateStartWindowMs} milliseconds after the current UTC timestamp.`,
      "Return only the tranche payload through the provided tool schema.",
      "The only accepted payload is a tranches JSON array inside the tool input.",
      "Each tranche must contain exactly amount and executeAtUtc.",
      "amount values must be atomic integer strings.",
      "executeAtUtc values must be UTC ISO timestamps ending in Z.",
      "The total of all tranche amounts must equal the source amount exactly.",
      input.executionMode === SwapExecutionMode.FAST
        ? `Split the swap into multiple steps and keep every adjacent tranche gap at or below ${policy.maxAdjacentGapMs} milliseconds.`
        : "Split the swap into multiple steps spread over time.",
      input.executionMode === SwapExecutionMode.SECURE &&
      policy.maxTotalWindowMs
        ? `The final tranche must execute within ${policy.maxTotalWindowMs} milliseconds of the current UTC timestamp.`
        : "",
    ];

    if (failureDetail) {
      promptLines.push(
        "",
        "Your previous response was invalid.",
        `Problems found: ${failureDetail}`,
        "What you did wrong last time: you did not satisfy the tranche payload contract exactly.",
        `Previous response: ${this.serializeForPrompt(previousResponse)}`,
        "Regenerate the full tranche plan and satisfy all rules.",
      );
    }

    return promptLines.filter(Boolean).join("\n");
  }

  private buildRequestBody(
    model: string,
    input: PlanSwapTranchesInput,
    policy: TranchePlanValidationPolicy,
    currentUtc: string,
    failureDetail?: string,
    previousResponse?: JsonValue | null,
  ): JsonObject {
    return {
      model,
      max_tokens: 1024,
      tool_choice: {
        type: "tool",
        name: TOOL_NAME,
      },
      tools: [
        {
          name: TOOL_NAME,
          description:
            "Return a UTC tranche schedule for a planned token swap as JSON. Use only atomic amount strings and UTC timestamps.",
          input_schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              tranches: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    amount: {
                      type: "string",
                      pattern: "^(0|[1-9]\\\\d*)$",
                    },
                    executeAtUtc: {
                      type: "string",
                    },
                  },
                  required: ["amount", "executeAtUtc"],
                },
              },
            },
            required: ["tranches"],
          },
        },
      ],
      system: [
        {
          type: "text",
          text: "Plan a tranche-based swap schedule that spreads execution across multiple UTC time slots to reduce execution footprint and timing concentration. Return only the tool payload. Do not include commentary.",
        },
      ],
      messages: [
        {
          role: "user",
          content: this.buildPrompt(
            input,
            currentUtc,
            policy,
            failureDetail,
            previousResponse,
          ),
        },
      ],
    };
  }

  private parseResponse(responseText: string): AnthropicMessageResponse {
    try {
      const parsed = JSON.parse(responseText);
      if (!this.isJsonObject(parsed)) {
        throw new RetryablePlannerResponseError(
          "Anthropic planning response root must be a JSON object",
          responseText,
        );
      }

      return parsed;
    } catch (error) {
      if (error instanceof RetryablePlannerResponseError) {
        throw error;
      }

      const detail = error instanceof Error ? error.message : String(error);
      throw new RetryablePlannerResponseError(
        `Anthropic planning response was not valid JSON: ${detail}`,
        responseText,
      );
    }
  }

  private extractTranches(parsedResponse: AnthropicMessageResponse): JsonValue {
    const toolUseBlock = Array.isArray(parsedResponse.content)
      ? parsedResponse.content.find((block): block is AnthropicToolUseBlock =>
          this.isToolUseBlock(block),
        )
      : undefined;

    if (!toolUseBlock?.input || !this.isJsonObject(toolUseBlock.input)) {
      throw new RetryablePlannerResponseError(
        "Anthropic planning response did not contain a valid tranche tool payload",
        parsedResponse,
      );
    }

    const inputKeys = Object.keys(toolUseBlock.input);
    if (
      inputKeys.length !== 1 ||
      inputKeys[0] !== "tranches" ||
      !Array.isArray(toolUseBlock.input.tranches)
    ) {
      throw new RetryablePlannerResponseError(
        "Anthropic planning response must provide only a tranches array inside the tool payload",
        parsedResponse,
      );
    }

    return toolUseBlock.input.tranches;
  }

  private validateTranches(
    tranches: JsonValue,
    parsedResponse: AnthropicMessageResponse,
    expectedFromAmount: string,
    currentUtc: string,
    policy: TranchePlanValidationPolicy,
  ): ClaudePlannedTranche[] {
    try {
      return this.tranchePlanValidationService.validate(
        tranches,
        expectedFromAmount,
        currentUtc,
        policy,
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new RetryablePlannerResponseError(
          this.getBadRequestMessage(error),
          parsedResponse,
        );
      }

      throw error;
    }
  }

  private toRetryableFailure(
    error: unknown,
  ): RetryablePlannerResponseError | undefined {
    if (error instanceof RetryablePlannerResponseError) {
      return error;
    }

    return undefined;
  }

  private getBadRequestMessage(error: BadRequestException): string {
    const response = error.getResponse();

    if (typeof response === "string") {
      return response;
    }

    if (
      typeof response === "object" &&
      response !== null &&
      "message" in response
    ) {
      const message = response.message;

      if (Array.isArray(message)) {
        return message.join(", ");
      }

      if (typeof message === "string") {
        return message;
      }
    }

    return error.message;
  }

  private serializeForPrompt(value: JsonValue | null | undefined): string {
    if (value === undefined) {
      return "undefined";
    }

    const serialized =
      typeof value === "string" ? value : JSON.stringify(value ?? null);
    return serialized.length > 4000
      ? `${serialized.slice(0, 4000)}...`
      : serialized;
  }

  private isToolUseBlock(value: JsonValue): value is AnthropicToolUseBlock {
    return (
      this.isJsonObject(value) &&
      value.type === "tool_use" &&
      value.name === TOOL_NAME
    );
  }

  private isJsonObject(value: JsonValue): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
