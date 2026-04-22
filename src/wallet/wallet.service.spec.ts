import { jest } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";

import { CustodyProvider } from "../common/enums/custody-provider.enum.js";
import { WalletAction } from "../common/enums/wallet-action.enum.js";
import type { CustodyProviderStrategy } from "./interfaces/custody-provider.strategy.js";
import { CustodyProviderRegistry } from "./providers/custody-provider.registry.js";
import { SolanaService } from "./solana.service.js";
import { WalletService } from "./wallet.service.js";

describe("WalletService", () => {
  const custodyStrategy: jest.Mocked<CustodyProviderStrategy> = {
    provider: CustodyProvider.MAGICBLOCK,
    deposit: jest.fn(),
    withdraw: jest.fn(),
    getPrivateBalance: jest.fn(),
  };

  const custodyProviderRegistry: jest.Mocked<
    Pick<CustodyProviderRegistry, "get">
  > = {
    get: jest.fn(),
  };

  const solanaService: jest.Mocked<
    Pick<SolanaService, "getPublicKey" | "signAndSendTransaction">
  > = {
    getPublicKey: jest.fn(),
    signAndSendTransaction: jest.fn(),
  };

  let service: WalletService;

  beforeEach(() => {
    const custodyProviderRegistryStub = Object.assign(
      Object.create(CustodyProviderRegistry.prototype),
      custodyProviderRegistry,
    ) as CustodyProviderRegistry;
    const solanaServiceStub = Object.assign(
      Object.create(SolanaService.prototype),
      solanaService,
    ) as SolanaService;

    service = new WalletService(custodyProviderRegistryStub, solanaServiceStub);
    jest.clearAllMocks();

    custodyProviderRegistry.get.mockReturnValue(custodyStrategy);
    solanaService.getPublicKey.mockReturnValue("owner-address");
  });

  it("signs and submits provider deposit transactions", async () => {
    custodyStrategy.deposit.mockResolvedValue({
      transactionBase64: "tx-deposit",
      raw: {},
    });
    solanaService.signAndSendTransaction.mockResolvedValue("signature-1");

    const result = await service.deposit({
      provider: CustodyProvider.MAGICBLOCK,
      mint: "So11111111111111111111111111111111111111112",
      amount: "15",
    });

    expect(custodyProviderRegistry.get).toHaveBeenCalledWith(
      CustodyProvider.MAGICBLOCK,
    );
    expect(custodyStrategy.deposit).toHaveBeenCalledWith({
      owner: "owner-address",
      mint: "So11111111111111111111111111111111111111112",
      amount: "15",
    });
    expect(solanaService.signAndSendTransaction).toHaveBeenCalledWith(
      "tx-deposit",
    );
    expect(result).toEqual({
      provider: CustodyProvider.MAGICBLOCK,
      action: WalletAction.DEPOSIT,
      owner: "owner-address",
      mint: "So11111111111111111111111111111111111111112",
      amount: "15",
      signature: "signature-1",
      providerPayload: {
        transactionBase64: "tx-deposit",
      },
    });
  });

  it("signs and submits provider withdraw transactions", async () => {
    custodyStrategy.getPrivateBalance.mockResolvedValue({
      balance: "12",
    });
    custodyStrategy.withdraw.mockResolvedValue({
      transactionBase64: "tx-withdraw",
      raw: {},
    });
    solanaService.signAndSendTransaction.mockResolvedValue("signature-2");

    const result = await service.withdraw({
      provider: CustodyProvider.MAGICBLOCK,
      mint: "So11111111111111111111111111111111111111112",
      amount: "9",
    });

    expect(custodyStrategy.withdraw).toHaveBeenCalledWith({
      owner: "owner-address",
      mint: "So11111111111111111111111111111111111111112",
      amount: "9",
    });
    expect(custodyStrategy.getPrivateBalance).toHaveBeenCalledWith({
      owner: "owner-address",
      mint: "So11111111111111111111111111111111111111112",
    });
    expect(result.action).toBe(WalletAction.WITHDRAW);
    expect(result.signature).toBe("signature-2");
  });

  it("fails withdraw when private balance is lower than requested", async () => {
    custodyStrategy.getPrivateBalance.mockResolvedValue({
      balance: "8",
    });

    await expect(
      service.withdraw({
        provider: CustodyProvider.MAGICBLOCK,
        mint: "So11111111111111111111111111111111111111112",
        amount: "9",
      }),
    ).rejects.toThrow(BadRequestException);

    expect(custodyStrategy.withdraw).not.toHaveBeenCalled();
    expect(solanaService.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("returns normalized private balance data", async () => {
    custodyStrategy.getPrivateBalance.mockResolvedValue({
      encryptedBalance: "123",
    });

    const result = await service.balance({
      provider: CustodyProvider.MAGICBLOCK,
      mint: "So11111111111111111111111111111111111111112",
    });

    expect(custodyStrategy.getPrivateBalance).toHaveBeenCalledWith({
      owner: "owner-address",
      mint: "So11111111111111111111111111111111111111112",
    });
    expect(result).toEqual({
      provider: CustodyProvider.MAGICBLOCK,
      owner: "owner-address",
      mint: "So11111111111111111111111111111111111111112",
      data: { encryptedBalance: "123" },
    });
  });
});
