import { BadRequestException } from "@nestjs/common";

import { SwapExecutionMode } from "../common/enums/swap-execution-mode.enum.js";
import { SwapPlanningPolicyService } from "../swap/services/swap-planning-policy.service.js";
import { TranchePlanValidationService } from "./tranche-plan-validation.service.js";

describe("TranchePlanValidationService", () => {
  const service = new TranchePlanValidationService();
  const planningPolicyService = new SwapPlanningPolicyService();
  const now = "2026-04-21T12:00:00.000Z";

  it("accepts a valid ordered UTC tranche plan", () => {
    const result = service.validate(
      [
        { amount: "10", executeAtUtc: "2026-04-21T12:00:05Z" },
        { amount: "20", executeAtUtc: "2026-04-21T12:10:05Z" },
      ],
      "30",
      now,
      planningPolicyService.resolve(SwapExecutionMode.FAST),
    );

    expect(result).toEqual([
      { amount: "10", executeAtUtc: "2026-04-21T12:00:05.000Z" },
      { amount: "20", executeAtUtc: "2026-04-21T12:10:05.000Z" },
    ]);
  });

  it("rejects tranche objects with extra fields", () => {
    expect(() =>
      service.validate(
        [
          {
            amount: "10",
            executeAtUtc: "2026-04-21T12:10:00Z",
            note: "extra",
          },
        ],
        "10",
        now,
        planningPolicyService.resolve(SwapExecutionMode.INSTANT),
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects invalid timestamp formats", () => {
    expect(() =>
      service.validate(
        [{ amount: "10", executeAtUtc: "2026-04-21 12:10:00" }],
        "10",
        now,
        planningPolicyService.resolve(SwapExecutionMode.FAST),
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects malformed amounts", () => {
    expect(() =>
      service.validate(
        [{ amount: "10.5", executeAtUtc: "2026-04-21T12:10:00Z" }],
        "10",
        now,
        planningPolicyService.resolve(SwapExecutionMode.FAST),
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects empty arrays", () => {
    expect(() =>
      service.validate(
        [],
        "10",
        now,
        planningPolicyService.resolve(SwapExecutionMode.FAST),
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects plans whose amounts do not match the source amount", () => {
    expect(() =>
      service.validate(
        [{ amount: "9", executeAtUtc: "2026-04-21T12:10:00Z" }],
        "10",
        now,
        planningPolicyService.resolve(SwapExecutionMode.INSTANT),
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects out-of-order timestamps", () => {
    expect(() =>
      service.validate(
        [
          { amount: "10", executeAtUtc: "2026-04-21T12:00:05Z" },
          { amount: "20", executeAtUtc: "2026-04-21T12:00:04Z" },
        ],
        "30",
        now,
        planningPolicyService.resolve(SwapExecutionMode.FAST),
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects instant mode plans with more than one tranche", () => {
    expect(() =>
      service.validate(
        [
          { amount: "10", executeAtUtc: "2026-04-21T12:00:05Z" },
          { amount: "20", executeAtUtc: "2026-04-21T12:00:06Z" },
        ],
        "30",
        now,
        planningPolicyService.resolve(SwapExecutionMode.INSTANT),
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects fast mode plans whose first tranche is not immediate", () => {
    expect(() =>
      service.validate(
        [
          { amount: "10", executeAtUtc: "2026-04-21T12:00:06Z" },
          { amount: "20", executeAtUtc: "2026-04-21T12:10:06Z" },
        ],
        "30",
        now,
        planningPolicyService.resolve(SwapExecutionMode.FAST),
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects fast mode plans with gaps over 10 minutes", () => {
    expect(() =>
      service.validate(
        [
          { amount: "10", executeAtUtc: "2026-04-21T12:00:05Z" },
          { amount: "20", executeAtUtc: "2026-04-21T12:10:06Z" },
        ],
        "30",
        now,
        planningPolicyService.resolve(SwapExecutionMode.FAST),
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects secure mode plans that exceed the 3 hour window", () => {
    expect(() =>
      service.validate(
        [
          { amount: "10", executeAtUtc: "2026-04-21T12:00:05Z" },
          { amount: "20", executeAtUtc: "2026-04-21T15:00:01Z" },
        ],
        "30",
        now,
        planningPolicyService.resolve(SwapExecutionMode.SECURE),
      ),
    ).toThrow(BadRequestException);
  });
});
