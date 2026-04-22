import { jest } from "@jest/globals";
import { BadGatewayException } from "@nestjs/common";

import { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import { SwapExecutionMode } from "../../common/enums/swap-execution-mode.enum.js";
import { SwapProvider } from "../../common/enums/swap-provider.enum.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { TempWalletCryptoService } from "../../swap/services/temp-wallet-crypto.service.js";
import { SolanaService } from "../solana.service.js";
import { CustodyProviderRegistry } from "./custody-provider.registry.js";
import {
  FlySwapExecutionFailure,
  FlySwapStrategy,
} from "./fly-swap.strategy.js";

describe("FlySwapStrategy", () => {
  const originalEnv = process.env;
  const fetchMock = jest.fn<typeof fetch>();
  const validTempWallet = "So11111111111111111111111111111111111111112";
  const validOwnerAddress = "So11111111111111111111111111111111111111112";

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SOLANA_PRIVATE_KEY:
        "2w4zArZXm3mpPf7Xg3ak9Y8A4VPPx7FQa1r4PXsC2hKwpPg6puwVSYQ6rk2jgN3V6GLA6P7L5Ts56ZWrmaPvVLbE",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      TEMP_WALLET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    };
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
      writable: true,
    });
    fetchMock.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function buildSwapJob(
    overrides?: Partial<{ slippage: string; executionMode: SwapExecutionMode }>,
  ) {
    return {
      slippage: "0.005",
      executionMode: SwapExecutionMode.FAST,
      ...overrides,
    };
  }

  it("requests a Fly quote and transaction with the expected params", async () => {
    const prisma = {
      swapTranche: {
        findUnique: jest.fn().mockImplementation(async () => ({
          id: "tranche-1",
          encryptedTempWalletSecret: Buffer.from(
            new Uint8Array(64).fill(1),
          ).toString("base64"),
          tempWalletEncryptionIv: "ignored",
          tempWalletEncryptionAuthTag: "ignored",
          swapJob: buildSwapJob({ slippage: "0.02" }),
        })),
        update: jest.fn().mockImplementation(async () => undefined),
      },
    };
    const tempWalletCryptoService = {
      decryptSecret: jest
        .fn()
        .mockReturnValue(
          Buffer.from(new Uint8Array(64).fill(1)).toString("base64"),
        ),
    };
    const solanaService = {
      getSigner: jest.fn().mockReturnValue({
        publicKey: {
          toBase58: () => validOwnerAddress,
        },
      }),
      getPublicKey: jest.fn().mockReturnValue(validOwnerAddress),
      decodeBase64SecretKey: jest.fn().mockReturnValue({
        publicKey: {
          toBase58: () => validTempWallet,
        },
      }),
      transferLamports: jest.fn().mockImplementation(async () => "funding-sig"),
      getConnection: jest.fn(),
      sendInstructions: jest.fn(),
      signAndSendSerializedTransaction: jest
        .fn()
        .mockImplementation(async () => "swap-sig"),
      signAndSendTransaction: jest
        .fn()
        .mockImplementationOnce(async () => "withdraw-sig")
        .mockImplementationOnce(async () => "deposit-sig"),
    };
    const custodyProviderRegistry = {
      get: jest.fn().mockReturnValue({
        withdraw: jest.fn().mockImplementation(async () => ({
          transactionBase64: "withdraw-tx",
          raw: {},
        })),
        deposit: jest.fn().mockImplementation(async () => ({
          transactionBase64: "deposit-tx",
          raw: {},
        })),
      }),
    };
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "quote-1",
            amountOut: "95",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: "base64-fly-tx",
          }),
          { status: 200 },
        ),
      );

    const strategy = new FlySwapStrategy(
      Object.assign(
        Object.create(PrismaService.prototype),
        prisma,
      ) as PrismaService,
      Object.assign(
        Object.create(TempWalletCryptoService.prototype),
        tempWalletCryptoService,
      ) as TempWalletCryptoService,
      Object.assign(
        Object.create(SolanaService.prototype),
        solanaService,
      ) as SolanaService,
      Object.assign(
        Object.create(CustodyProviderRegistry.prototype),
        custodyProviderRegistry,
      ) as CustodyProviderRegistry,
    );

    await strategy.markTrancheReady({
      swapJobId: "swap-1",
      trancheId: "tranche-1",
      custodyProvider: CustodyProvider.MAGICBLOCK,
      swapProvider: SwapProvider.FLY,
      fromMint: "11111111111111111111111111111111",
      toMint: "So11111111111111111111111111111111111111112",
      amount: "10",
      tempWalletPublicKey: validTempWallet,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("https://api.magpiefi.io/aggregator/quote?"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          accept: "application/json",
        }),
      }),
    );
    const calledQuoteUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledQuoteUrl).toContain("network=solana");
    expect(calledQuoteUrl).toContain("slippage=0.02");
    expect(calledQuoteUrl).toContain(`fromAddress=${validTempWallet}`);
    expect(calledQuoteUrl).toContain(`toAddress=${validOwnerAddress}`);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.magpiefi.io/aggregator/transaction?quoteId=quote-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          accept: "application/json",
        }),
      }),
    );
    expect(solanaService.signAndSendSerializedTransaction).toHaveBeenCalledWith(
      "base64-fly-tx",
      [expect.anything()],
    );
    expect(solanaService.signAndSendTransaction).toHaveBeenNthCalledWith(
      1,
      "withdraw-tx",
    );
    expect(solanaService.signAndSendTransaction).toHaveBeenNthCalledWith(
      2,
      "deposit-tx",
    );
  });

  it("fails when Fly does not return serialized transaction data", async () => {
    const prisma = {
      swapTranche: {
        findUnique: jest.fn().mockImplementation(async () => ({
          id: "tranche-1",
          encryptedTempWalletSecret: Buffer.from(
            new Uint8Array(64).fill(1),
          ).toString("base64"),
          tempWalletEncryptionIv: "ignored",
          tempWalletEncryptionAuthTag: "ignored",
          swapJob: buildSwapJob(),
        })),
        update: jest.fn().mockImplementation(async () => undefined),
      },
    };
    const tempWalletCryptoService = {
      decryptSecret: jest
        .fn()
        .mockReturnValue(
          Buffer.from(new Uint8Array(64).fill(1)).toString("base64"),
        ),
    };
    const solanaService = {
      getSigner: jest.fn().mockReturnValue({
        publicKey: {
          toBase58: () => validOwnerAddress,
        },
      }),
      getPublicKey: jest.fn().mockReturnValue(validOwnerAddress),
      decodeBase64SecretKey: jest.fn().mockReturnValue({
        publicKey: {
          toBase58: () => validTempWallet,
        },
      }),
      transferLamports: jest.fn().mockImplementation(async () => "funding-sig"),
      getConnection: jest.fn(),
      sendInstructions: jest.fn(),
      signAndSendSerializedTransaction: jest.fn(),
      signAndSendTransaction: jest
        .fn()
        .mockImplementation(async () => "withdraw-sig"),
    };
    const custodyProviderRegistry = {
      get: jest.fn().mockReturnValue({
        withdraw: jest.fn().mockImplementation(async () => ({
          transactionBase64: "withdraw-tx",
          raw: {},
        })),
      }),
    };
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "quote-1",
            amountOut: "95",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const strategy = new FlySwapStrategy(
      Object.assign(
        Object.create(PrismaService.prototype),
        prisma,
      ) as PrismaService,
      Object.assign(
        Object.create(TempWalletCryptoService.prototype),
        tempWalletCryptoService,
      ) as TempWalletCryptoService,
      Object.assign(
        Object.create(SolanaService.prototype),
        solanaService,
      ) as SolanaService,
      Object.assign(
        Object.create(CustodyProviderRegistry.prototype),
        custodyProviderRegistry,
      ) as CustodyProviderRegistry,
    );

    await expect(
      strategy.markTrancheReady({
        swapJobId: "swap-1",
        trancheId: "tranche-1",
        custodyProvider: CustodyProvider.MAGICBLOCK,
        swapProvider: SwapProvider.FLY,
        fromMint: "11111111111111111111111111111111",
        toMint: "So11111111111111111111111111111111111111112",
        amount: "10",
        tempWalletPublicKey: validTempWallet,
      }),
    ).rejects.toThrow(BadGatewayException);
  });

  it("uses a preloaded instant quote id without fetching a fresh Fly quote", async () => {
    const prisma = {
      swapTranche: {
        findUnique: jest.fn().mockImplementation(async () => ({
          id: "tranche-1",
          encryptedTempWalletSecret: Buffer.from(
            new Uint8Array(64).fill(1),
          ).toString("base64"),
          tempWalletEncryptionIv: "ignored",
          tempWalletEncryptionAuthTag: "ignored",
          swapJob: buildSwapJob({ executionMode: SwapExecutionMode.INSTANT }),
        })),
        update: jest.fn().mockImplementation(async () => undefined),
      },
    };
    const tempWalletCryptoService = {
      decryptSecret: jest
        .fn()
        .mockReturnValue(
          Buffer.from(new Uint8Array(64).fill(1)).toString("base64"),
        ),
    };
    const solanaService = {
      getSigner: jest.fn().mockReturnValue({
        publicKey: {
          toBase58: () => validOwnerAddress,
        },
      }),
      getPublicKey: jest.fn().mockReturnValue(validOwnerAddress),
      decodeBase64SecretKey: jest.fn().mockReturnValue({
        publicKey: {
          toBase58: () => validTempWallet,
        },
      }),
      transferLamports: jest.fn().mockImplementation(async () => "funding-sig"),
      getConnection: jest.fn(),
      sendInstructions: jest.fn(),
      signAndSendSerializedTransaction: jest
        .fn()
        .mockImplementation(async () => "swap-sig"),
      signAndSendTransaction: jest
        .fn()
        .mockImplementationOnce(async () => "withdraw-sig")
        .mockImplementationOnce(async () => "deposit-sig"),
    };
    const custodyProviderRegistry = {
      get: jest.fn().mockReturnValue({
        withdraw: jest.fn().mockImplementation(async () => ({
          transactionBase64: "withdraw-tx",
          raw: {},
        })),
        deposit: jest.fn().mockImplementation(async () => ({
          transactionBase64: "deposit-tx",
          raw: {},
        })),
      }),
    };
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: "base64-fly-tx",
        }),
        { status: 200 },
      ),
    );

    const strategy = new FlySwapStrategy(
      Object.assign(
        Object.create(PrismaService.prototype),
        prisma,
      ) as PrismaService,
      Object.assign(
        Object.create(TempWalletCryptoService.prototype),
        tempWalletCryptoService,
      ) as TempWalletCryptoService,
      Object.assign(
        Object.create(SolanaService.prototype),
        solanaService,
      ) as SolanaService,
      Object.assign(
        Object.create(CustodyProviderRegistry.prototype),
        custodyProviderRegistry,
      ) as CustodyProviderRegistry,
    );

    await strategy.markTrancheReady({
      swapJobId: "swap-1",
      trancheId: "tranche-1",
      custodyProvider: CustodyProvider.MAGICBLOCK,
      swapProvider: SwapProvider.FLY,
      fromMint: "11111111111111111111111111111111",
      toMint: "So11111111111111111111111111111111111111112",
      amount: "10",
      tempWalletPublicKey: validTempWallet,
      preloadedQuote: {
        quoteId: "quote-1",
        amountOut: "95",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.magpiefi.io/aggregator/transaction?quoteId=quote-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          accept: "application/json",
        }),
      }),
    );
    expect(solanaService.signAndSendSerializedTransaction).toHaveBeenCalledWith(
      "base64-fly-tx",
      [expect.anything()],
    );
    expect(prisma.swapTranche.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          withdrawSignature: "withdraw-sig",
        }),
      }),
    );
    expect(prisma.swapTranche.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quoteId: "quote-1",
          quoteTool: SwapProvider.FLY,
        }),
      }),
    );
  });

  it("compensates and classifies quote expiry for instant swaps", async () => {
    const prisma = {
      swapTranche: {
        findUnique: jest.fn().mockImplementation(async () => ({
          id: "tranche-1",
          encryptedTempWalletSecret: Buffer.from(
            new Uint8Array(64).fill(1),
          ).toString("base64"),
          tempWalletEncryptionIv: "ignored",
          tempWalletEncryptionAuthTag: "ignored",
          swapJob: buildSwapJob({ executionMode: SwapExecutionMode.INSTANT }),
        })),
        update: jest.fn().mockImplementation(async () => undefined),
      },
    };
    const tempWalletCryptoService = {
      decryptSecret: jest
        .fn()
        .mockReturnValue(
          Buffer.from(new Uint8Array(64).fill(1)).toString("base64"),
        ),
    };
    const solanaService = {
      getSigner: jest.fn().mockReturnValue({
        publicKey: {
          toBase58: () => validOwnerAddress,
        },
      }),
      getPublicKey: jest.fn().mockReturnValue(validOwnerAddress),
      decodeBase64SecretKey: jest.fn().mockReturnValue({
        publicKey: {
          toBase58: () => validTempWallet,
        },
      }),
      transferLamports: jest.fn(),
      getConnection: jest.fn(),
      sendInstructions: jest
        .fn()
        .mockImplementation(async () => "refund-ix-sig"),
      signAndSendSerializedTransaction: jest.fn(),
      signAndSendTransaction: jest
        .fn()
        .mockImplementationOnce(async () => "withdraw-sig")
        .mockImplementationOnce(async () => "refund-deposit-sig"),
    };
    const custodyProviderRegistry = {
      get: jest.fn().mockReturnValue({
        withdraw: jest.fn().mockImplementation(async () => ({
          transactionBase64: "withdraw-tx",
          raw: {},
        })),
        deposit: jest.fn().mockImplementation(async () => ({
          transactionBase64: "deposit-tx",
          raw: {},
        })),
      }),
    };
    fetchMock.mockResolvedValue(new Response("quote expired", { status: 410 }));

    const strategy = new FlySwapStrategy(
      Object.assign(
        Object.create(PrismaService.prototype),
        prisma,
      ) as PrismaService,
      Object.assign(
        Object.create(TempWalletCryptoService.prototype),
        tempWalletCryptoService,
      ) as TempWalletCryptoService,
      Object.assign(
        Object.create(SolanaService.prototype),
        solanaService,
      ) as SolanaService,
      Object.assign(
        Object.create(CustodyProviderRegistry.prototype),
        custodyProviderRegistry,
      ) as CustodyProviderRegistry,
    );

    await expect(
      strategy.markTrancheReady({
        swapJobId: "swap-1",
        trancheId: "tranche-1",
        custodyProvider: CustodyProvider.MAGICBLOCK,
        swapProvider: SwapProvider.FLY,
        fromMint: "11111111111111111111111111111111",
        toMint: "So11111111111111111111111111111111111111112",
        amount: "10",
        tempWalletPublicKey: validTempWallet,
        preloadedQuote: {
          quoteId: "quote-1",
          amountOut: "95",
        },
      }),
    ).rejects.toMatchObject({
      code: "QUOTE_EXPIRED",
      shouldPauseSwapJob: false,
    } satisfies Partial<FlySwapExecutionFailure>);
    expect(solanaService.sendInstructions).toHaveBeenCalledTimes(1);
    expect(solanaService.signAndSendTransaction).toHaveBeenNthCalledWith(
      2,
      "deposit-tx",
    );
  });

  it("surfaces compensation failures distinctly for scheduled swaps", async () => {
    const prisma = {
      swapTranche: {
        findUnique: jest.fn().mockImplementation(async () => ({
          id: "tranche-1",
          encryptedTempWalletSecret: Buffer.from(
            new Uint8Array(64).fill(1),
          ).toString("base64"),
          tempWalletEncryptionIv: "ignored",
          tempWalletEncryptionAuthTag: "ignored",
          swapJob: buildSwapJob(),
        })),
        update: jest.fn().mockImplementation(async () => undefined),
      },
    };
    const tempWalletCryptoService = {
      decryptSecret: jest
        .fn()
        .mockReturnValue(
          Buffer.from(new Uint8Array(64).fill(1)).toString("base64"),
        ),
    };
    const solanaService = {
      getSigner: jest.fn().mockReturnValue({
        publicKey: {
          toBase58: () => validOwnerAddress,
        },
      }),
      getPublicKey: jest.fn().mockReturnValue(validOwnerAddress),
      decodeBase64SecretKey: jest.fn().mockReturnValue({
        publicKey: {
          toBase58: () => validTempWallet,
        },
      }),
      transferLamports: jest.fn(),
      getConnection: jest.fn(),
      sendInstructions: jest.fn().mockImplementation(async () => {
        throw new Error("refund failed");
      }),
      signAndSendSerializedTransaction: jest.fn(),
      signAndSendTransaction: jest
        .fn()
        .mockImplementationOnce(async () => "withdraw-sig"),
    };
    const custodyProviderRegistry = {
      get: jest.fn().mockReturnValue({
        withdraw: jest.fn().mockImplementation(async () => ({
          transactionBase64: "withdraw-tx",
          raw: {},
        })),
        deposit: jest.fn(),
      }),
    };
    fetchMock.mockResolvedValue(new Response("quote expired", { status: 410 }));

    const strategy = new FlySwapStrategy(
      Object.assign(
        Object.create(PrismaService.prototype),
        prisma,
      ) as PrismaService,
      Object.assign(
        Object.create(TempWalletCryptoService.prototype),
        tempWalletCryptoService,
      ) as TempWalletCryptoService,
      Object.assign(
        Object.create(SolanaService.prototype),
        solanaService,
      ) as SolanaService,
      Object.assign(
        Object.create(CustodyProviderRegistry.prototype),
        custodyProviderRegistry,
      ) as CustodyProviderRegistry,
    );

    await expect(
      strategy.markTrancheReady({
        swapJobId: "swap-1",
        trancheId: "tranche-1",
        custodyProvider: CustodyProvider.MAGICBLOCK,
        swapProvider: SwapProvider.FLY,
        fromMint: "11111111111111111111111111111111",
        toMint: "So11111111111111111111111111111111111111112",
        amount: "10",
        tempWalletPublicKey: validTempWallet,
        preloadedQuote: {
          quoteId: "quote-1",
          amountOut: "95",
        },
      }),
    ).rejects.toMatchObject({
      code: "COMPENSATION_FAILED",
      shouldPauseSwapJob: true,
    } satisfies Partial<FlySwapExecutionFailure>);
  });
});
