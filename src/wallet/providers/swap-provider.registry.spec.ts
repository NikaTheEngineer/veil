import { jest } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";

import { SwapProvider } from "../../common/enums/swap-provider.enum.js";
import type { SwapProviderStrategy } from "../interfaces/swap-provider.strategy.js";
import type { FlySwapStrategy } from "./fly-swap.strategy.js";
import { SwapProviderRegistry } from "./swap-provider.registry.js";

describe("SwapProviderRegistry", () => {
  it("returns a strategy by enum key", () => {
    const strategy: SwapProviderStrategy = {
      provider: SwapProvider.FLY,
      prepareExecution: jest.fn(async () => undefined),
      markTrancheReady: jest.fn(async () => undefined),
    };

    const registry = new SwapProviderRegistry(strategy as FlySwapStrategy);

    expect(registry.get(SwapProvider.FLY)).toBe(strategy);
  });

  it("throws for an unsupported provider", () => {
    const strategy: SwapProviderStrategy = {
      provider: SwapProvider.FLY,
      prepareExecution: jest.fn(async () => undefined),
      markTrancheReady: jest.fn(async () => undefined),
    };
    const registry = new SwapProviderRegistry(strategy as FlySwapStrategy);

    expect(() => registry.get("OTHER_PROVIDER" as SwapProvider)).toThrow(
      BadRequestException,
    );
  });
});
