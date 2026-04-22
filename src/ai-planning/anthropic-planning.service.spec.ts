import { jest } from "@jest/globals";
import {
  BadGatewayException,
  InternalServerErrorException,
} from "@nestjs/common";

import { SwapExecutionMode } from "../common/enums/swap-execution-mode.enum.js";
import { SwapPlanningPolicyService } from "../swap/services/swap-planning-policy.service.js";
import { AnthropicPlanningService } from "./anthropic-planning.service.js";
import { TranchePlanValidationService } from "./tranche-plan-validation.service.js";

describe("AnthropicPlanningService", () => {
  const originalEnv = process.env;
  const fetchMock = jest.fn<typeof fetch>();
  const planningPolicyService = new SwapPlanningPolicyService();
  const validator = new TranchePlanValidationService();
  const buildFastTranches = () => {
    const baseTime = Date.now();
    return [
      {
        amount: "4",
        executeAtUtc: new Date(baseTime + 3000).toISOString(),
      },
      {
        amount: "6",
        executeAtUtc: new Date(baseTime + 603000).toISOString(),
      },
    ];
  };
  const buildSecureTranches = () => {
    const baseTime = Date.now();
    return [
      {
        amount: "5",
        executeAtUtc: new Date(baseTime + 3000).toISOString(),
      },
      {
        amount: "5",
        executeAtUtc: new Date(baseTime + 7_200_000).toISOString(),
      },
    ];
  };
  const buildInvalidSumTranches = () => {
    const baseTime = Date.now();
    return [
      {
        amount: "4",
        executeAtUtc: new Date(baseTime + 3000).toISOString(),
      },
      {
        amount: "5",
        executeAtUtc: new Date(baseTime + 603000).toISOString(),
      },
    ];
  };
  const buildInput = (executionMode = SwapExecutionMode.FAST) => ({
    custodyProvider: "MAGICBLOCK",
    swapProvider: "FLY",
    executionMode,
    fromMint: "So11111111111111111111111111111111111111112",
    toMint: "So11111111111111111111111111111111111111112",
    fromAmount: "10",
    targetToAmount: "9",
    immediateStartWindowMs: 5000,
    maxAdjacentGapMs: 600000,
    maxTotalWindowMs: 10800000,
  });

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ANTHROPIC_API_KEY: "test-api-key",
      ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
    };

    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });
    fetchMock.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("builds a structured planning request and parses validated tool output", async () => {
    const service = new AnthropicPlanningService(validator);
    const fastTranches = buildFastTranches();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "record_swap_tranches",
              input: {
                tranches: fastTranches,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await service.planTranches(
      buildInput(SwapExecutionMode.FAST),
      planningPolicyService.resolve(SwapExecutionMode.FAST),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test-api-key",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.promptVersion).toBe("swap-tranche-planner-v3");
    expect(result.tranches).toEqual(
      fastTranches.map((tranche) => ({
        amount: tranche.amount,
        executeAtUtc: new Date(tranche.executeAtUtc).toISOString(),
      })),
    );
    const requestBody = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    ) as {
      messages: Array<{ content: string }>;
    };
    expect(requestBody.messages[0].content).toContain("Execution mode: FAST");
    expect(requestBody.messages[0].content).toContain(
      "every adjacent tranche gap at or below 600000 milliseconds",
    );
    expect(requestBody.messages[0].content).toContain(
      "Each tranche must contain exactly amount and executeAtUtc.",
    );
  });

  it("retries when the planner response does not contain a tool payload", async () => {
    const service = new AnthropicPlanningService(validator);
    const fastTranches = buildFastTranches();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "tool_use",
                name: "record_swap_tranches",
                input: {
                  tranches: fastTranches,
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const result = await service.planTranches(
      buildInput(SwapExecutionMode.FAST),
      planningPolicyService.resolve(SwapExecutionMode.FAST),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.tranches).toHaveLength(2);
    const secondRequestBody = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as {
      messages: Array<{ content: string }>;
    };
    expect(secondRequestBody.messages[0].content).toContain(
      "Your previous response was invalid.",
    );
    expect(secondRequestBody.messages[0].content).toContain(
      "did not contain a valid tranche tool payload",
    );
  });

  it("retries when tranche amounts do not sum to the source amount and includes the prior response in the retry prompt", async () => {
    const service = new AnthropicPlanningService(validator);
    const invalidSumTranches = buildInvalidSumTranches();
    const fastTranches = buildFastTranches();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "tool_use",
                name: "record_swap_tranches",
                input: {
                  tranches: invalidSumTranches,
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "tool_use",
                name: "record_swap_tranches",
                input: {
                  tranches: fastTranches,
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

    await service.planTranches(
      buildInput(SwapExecutionMode.FAST),
      planningPolicyService.resolve(SwapExecutionMode.FAST),
    );

    const secondRequestBody = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as {
      messages: Array<{ content: string }>;
    };
    expect(secondRequestBody.messages[0].content).toContain(
      "Claude planner tranche amounts must sum to the requested source amount",
    );
    expect(secondRequestBody.messages[0].content).toContain(
      `"amount":"${invalidSumTranches[0].amount}"`,
    );
  });

  it("retries when fields are wrong and succeeds after a corrected response", async () => {
    const service = new AnthropicPlanningService(validator);
    const fastTranches = buildFastTranches();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "tool_use",
                name: "record_swap_tranches",
                input: {
                  tranches: [
                    {
                      amount: "10",
                      executeAtUtc: new Date(Date.now() + 3000).toISOString(),
                      extraField: "bad",
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "tool_use",
                name: "record_swap_tranches",
                input: {
                  tranches: fastTranches,
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const result = await service.planTranches(
      buildInput(SwapExecutionMode.FAST),
      planningPolicyService.resolve(SwapExecutionMode.FAST),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.tranches).toHaveLength(2);
  });

  it("includes secure timing constraints in the planner prompt", async () => {
    const service = new AnthropicPlanningService(validator);
    const secureTranches = buildSecureTranches();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "record_swap_tranches",
              input: {
                tranches: secureTranches,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await service.planTranches(
      buildInput(SwapExecutionMode.SECURE),
      planningPolicyService.resolve(SwapExecutionMode.SECURE),
    );

    const requestBody = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    ) as {
      messages: Array<{ content: string }>;
    };
    expect(requestBody.messages[0].content).toContain("Execution mode: SECURE");
    expect(requestBody.messages[0].content).toContain(
      "The final tranche must execute within 10800000 milliseconds",
    );
  });

  it("stops after 10 failed attempts and reports the last validation error", async () => {
    const service = new AnthropicPlanningService(validator);
    const invalidSumTranches = buildInvalidSumTranches();
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: "tool_use",
                name: "record_swap_tranches",
                input: {
                  tranches: invalidSumTranches,
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const planningPromise = service.planTranches(
      buildInput(SwapExecutionMode.FAST),
      planningPolicyService.resolve(SwapExecutionMode.FAST),
    );

    await expect(planningPromise).rejects.toThrow(BadGatewayException);
    await expect(planningPromise).rejects.toThrow(
      "Anthropic planning failed after 10 attempts: Claude planner tranche amounts must sum to the requested source amount",
    );
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("fails when ANTHROPIC_API_KEY is missing", async () => {
    const service = new AnthropicPlanningService(validator);
    delete process.env.ANTHROPIC_API_KEY;

    await expect(
      service.planTranches(
        buildInput(SwapExecutionMode.FAST),
        planningPolicyService.resolve(SwapExecutionMode.FAST),
      ),
    ).rejects.toThrow(InternalServerErrorException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry non-200 Anthropic responses", async () => {
    const service = new AnthropicPlanningService(validator);
    fetchMock.mockResolvedValue(
      new Response("upstream failure", { status: 502 }),
    );

    await expect(
      service.planTranches(
        buildInput(SwapExecutionMode.FAST),
        planningPolicyService.resolve(SwapExecutionMode.FAST),
      ),
    ).rejects.toThrow(BadGatewayException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
