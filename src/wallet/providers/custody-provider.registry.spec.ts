import { jest } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";

import { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import type { CustodyProviderStrategy } from "../interfaces/custody-provider.strategy.js";
import { CustodyProviderRegistry } from "./custody-provider.registry.js";
import type { MagicBlockCustodyStrategy } from "./magicblock-custody.strategy.js";

describe("CustodyProviderRegistry", () => {
  it("returns a strategy by enum key", () => {
    const strategy: CustodyProviderStrategy = {
      provider: CustodyProvider.MAGICBLOCK,
      deposit: jest.fn(async () => ({ transactionBase64: "tx", raw: {} })),
      transfer: jest.fn(async () => ({ transactionBase64: "tx", raw: {} })),
      withdraw: jest.fn(async () => ({ transactionBase64: "tx", raw: {} })),
      getPrivateBalance: jest.fn(async () => ({ balance: "1" })),
    };

    const registry = new CustodyProviderRegistry(
      strategy as MagicBlockCustodyStrategy,
    );

    expect(registry.get(CustodyProvider.MAGICBLOCK)).toBe(strategy);
  });

  it("throws for an unsupported provider", () => {
    const strategy: CustodyProviderStrategy = {
      provider: CustodyProvider.MAGICBLOCK,
      deposit: jest.fn(async () => ({ transactionBase64: "tx", raw: {} })),
      transfer: jest.fn(async () => ({ transactionBase64: "tx", raw: {} })),
      withdraw: jest.fn(async () => ({ transactionBase64: "tx", raw: {} })),
      getPrivateBalance: jest.fn(async () => ({ balance: "1" })),
    };
    const registry = new CustodyProviderRegistry(
      strategy as MagicBlockCustodyStrategy,
    );

    expect(() => registry.get("OTHER_PROVIDER" as CustodyProvider)).toThrow(
      BadRequestException,
    );
  });
});
