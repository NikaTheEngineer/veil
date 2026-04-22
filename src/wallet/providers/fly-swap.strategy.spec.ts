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
  const buildRefundConnection = () => ({
    getBalance: jest.fn(async () => 100_000_000),
    getTokenAccountBalance: jest.fn(async () => ({
      context: { slot: 1 },
      value: {
        amount: "95",
        decimals: 6,
        uiAmount: 0.000095,
        uiAmountString: "0.000095",
      },
    })),
    getLatestBlockhash: jest.fn(async () => ({
      blockhash: "11111111111111111111111111111111",
    })),
    getFeeForMessage: jest.fn(async () => ({
      context: { slot: 1 },
      value: 5_000,
    })),
  });

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
      getConnection: jest.fn().mockReturnValue(buildRefundConnection()),
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
        transfer: jest.fn().mockImplementation(async () => ({
          transactionBase64: "transfer-tx",
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
    expect(calledQuoteUrl).toContain(`toAddress=${validTempWallet}`);
    expect(calledQuoteUrl).toContain(`feePayer=${validOwnerAddress}`);

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
      [expect.anything(), expect.anything()],
    );
    expect(solanaService.signAndSendSerializedTransaction).toHaveBeenNthCalledWith(
      2,
      "transfer-tx",
      [expect.anything()],
    );
    expect(solanaService.signAndSendTransaction).toHaveBeenNthCalledWith(
      1,
      "withdraw-tx",
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
      getConnection: jest.fn().mockReturnValue(buildRefundConnection()),
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
        transfer: jest.fn().mockImplementation(async () => ({
          transactionBase64: "transfer-tx",
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

  it("leaves instant swap funds in MagicBlock custody when execution fails before withdrawal", async () => {
    const custodyStrategy = {
      withdraw: jest.fn().mockImplementation(async () => {
        throw new BadGatewayException("Quote expired before execution");
      }),
      transfer: jest.fn(),
      deposit: jest.fn().mockImplementation(async () => ({
        transactionBase64: "deposit-tx",
        raw: {},
      })),
    };
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
      getConnection: jest.fn().mockReturnValue(buildRefundConnection()),
      sendInstructions: jest.fn(),
      signAndSendSerializedTransaction: jest.fn(),
      signAndSendTransaction: jest.fn(),
    };
    const custodyProviderRegistry = {
      get: jest.fn().mockReturnValue(custodyStrategy),
    };

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
    ).rejects.toThrow(
      "Quote expired before execution. Source funds remained in MagicBlock custody.",
    );

    expect(custodyStrategy.withdraw).toHaveBeenCalledTimes(1);
    expect(solanaService.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("completes instant swaps by depositing the output back into MagicBlock custody", async () => {
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
      getConnection: jest.fn().mockReturnValue(buildRefundConnection()),
      sendInstructions: jest.fn(),
      signAndSendSerializedTransaction: jest
        .fn()
        .mockImplementationOnce(async () => "swap-sig")
        .mockImplementationOnce(async () => "deposit-sig"),
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
        transfer: jest.fn().mockImplementation(async () => ({
          transactionBase64: "transfer-tx",
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

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      [expect.anything(), expect.anything()],
    );
    const calledQuoteUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledQuoteUrl).toContain(`fromAddress=${validTempWallet}`);
    expect(calledQuoteUrl).toContain(`toAddress=${validTempWallet}`);
    expect(calledQuoteUrl).toContain(`feePayer=${validOwnerAddress}`);
    expect(solanaService.signAndSendSerializedTransaction).toHaveBeenCalledTimes(
      2,
    );
    expect(solanaService.signAndSendSerializedTransaction).toHaveBeenNthCalledWith(
      2,
      "transfer-tx",
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
    expect(prisma.swapTranche.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "COMPLETED",
          statusReason: "Tranche swap completed and custody deposit submitted",
          depositSignature: "deposit-sig",
          lastError: null,
        }),
      }),
    );
    expect(custodyProviderRegistry.get).toHaveBeenCalledTimes(2);
  });

  it("uses the temp wallet's actual settled token balance for the custody transfer", async () => {
    const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const transfer = jest.fn().mockImplementation(async () => ({
      transactionBase64: "transfer-tx",
      raw: {},
    }));
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
      getConnection: jest.fn().mockReturnValue({
        ...buildRefundConnection(),
        getTokenAccountBalance: jest.fn(async () => ({
          context: { slot: 1 },
          value: {
            amount: "90",
            decimals: 6,
            uiAmount: 0.00009,
            uiAmountString: "0.00009",
          },
        })),
      }),
      sendInstructions: jest.fn(),
      signAndSendSerializedTransaction: jest
        .fn()
        .mockImplementationOnce(async () => "swap-sig")
        .mockImplementationOnce(async () => "deposit-sig"),
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
        transfer,
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
      toMint: usdcMint,
      amount: "10",
      tempWalletPublicKey: validTempWallet,
    });

    expect(transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        mint: usdcMint,
        amount: "90",
      }),
    );
  });

  it("tops up the temp wallet from the main wallet before custody deposit when lamports are low", async () => {
    const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
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
    const transferLamports = jest
      .fn()
      .mockImplementationOnce(async () => "funding-sig")
      .mockImplementationOnce(async () => "topup-sig");
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
      transferLamports,
      getConnection: jest.fn().mockReturnValue({
        ...buildRefundConnection(),
        getBalance: jest
          .fn()
          .mockResolvedValueOnce(47_320)
          .mockResolvedValue(100_000_000),
        getTokenAccountBalance: jest.fn(async () => ({
          context: { slot: 1 },
          value: {
            amount: "90",
            decimals: 6,
            uiAmount: 0.00009,
            uiAmountString: "0.00009",
          },
        })),
      }),
      sendInstructions: jest.fn(),
      signAndSendSerializedTransaction: jest
        .fn()
        .mockImplementationOnce(async () => "swap-sig")
        .mockImplementationOnce(async () => "base-deposit-sig")
        .mockImplementationOnce(async () => "deposit-sig"),
      signAndSendTransaction: jest.fn(),
    };
    const custodyProviderRegistry = {
      get: jest.fn().mockReturnValue({
        withdraw: jest.fn().mockImplementation(async () => ({
          transactionBase64: "withdraw-tx",
          raw: {},
        })),
        transfer: jest.fn().mockImplementation(async () => ({
          transactionBase64: "transfer-tx",
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
      toMint: usdcMint,
      amount: "10",
      tempWalletPublicKey: validTempWallet,
    });

    expect(transferLamports).toHaveBeenNthCalledWith(
      2,
      validTempWallet,
      99_952_680n,
    );
  });

  it("compensates and classifies quote expiry for instant swaps", async () => {
    const custodyStrategy = {
      withdraw: jest.fn().mockImplementation(async () => ({
        transactionBase64: "withdraw-tx",
        raw: {},
      })),
      transfer: jest.fn().mockImplementation(async () => ({
        transactionBase64: "transfer-tx",
        raw: {},
      })),
      deposit: jest.fn().mockImplementation(async () => ({
        transactionBase64: "deposit-tx",
        raw: {},
      })),
    };
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
      getConnection: jest.fn().mockReturnValue(buildRefundConnection()),
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
      get: jest.fn().mockReturnValue(custodyStrategy),
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
      }),
    ).rejects.toMatchObject({
      code: "QUOTE_EXPIRED",
      shouldPauseSwapJob: false,
    } satisfies Partial<FlySwapExecutionFailure>);
    expect(solanaService.sendInstructions).toHaveBeenCalledTimes(1);
    expect(solanaService.signAndSendTransaction).toHaveBeenCalledTimes(2);
    expect(custodyStrategy.transfer).not.toHaveBeenCalled();
    expect(custodyStrategy.deposit).toHaveBeenCalledTimes(1);
  });

  it("returns failed scheduled swap funds to MagicBlock custody", async () => {
    const custodyStrategy = {
      withdraw: jest.fn().mockImplementation(async () => ({
        transactionBase64: "withdraw-tx",
        raw: {},
      })),
      transfer: jest.fn().mockImplementation(async () => ({
        transactionBase64: "transfer-tx",
        raw: {},
      })),
      deposit: jest.fn().mockImplementation(async () => ({
        transactionBase64: "deposit-tx",
        raw: {},
      })),
    };
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
      getConnection: jest.fn().mockReturnValue(buildRefundConnection()),
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
      get: jest.fn().mockReturnValue(custodyStrategy),
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
      }),
    ).rejects.toMatchObject({
      code: "QUOTE_EXPIRED",
      shouldPauseSwapJob: true,
    } satisfies Partial<FlySwapExecutionFailure>);
    expect(solanaService.sendInstructions).toHaveBeenCalledTimes(1);
    expect(solanaService.signAndSendSerializedTransaction).not.toHaveBeenCalled();
    expect(custodyStrategy.transfer).not.toHaveBeenCalled();
  });

  it("moves swapped output into MagicBlock ephemeral balance with private transfer", async () => {
    const custodyStrategy = {
      withdraw: jest.fn().mockImplementation(async () => ({
        transactionBase64: "withdraw-tx",
        raw: {},
      })),
      transfer: jest.fn().mockImplementation(async () => ({
        transactionBase64: "transfer-tx",
        raw: {},
      })),
      deposit: jest.fn().mockImplementation(async () => ({
        transactionBase64: "deposit-tx",
        raw: {},
      })),
    };
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
      getConnection: jest.fn().mockReturnValue(buildRefundConnection()),
      sendInstructions: jest.fn(),
      signAndSendSerializedTransaction: jest
        .fn()
        .mockImplementationOnce(async () => "swap-sig")
        .mockImplementationOnce(async () => "base-deposit-sig")
        .mockImplementationOnce(async () => "transfer-sig"),
      signAndSendTransaction: jest
        .fn()
        .mockImplementationOnce(async () => "withdraw-sig"),
    };
    const custodyProviderRegistry = {
      get: jest.fn().mockReturnValue(custodyStrategy),
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
      toMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "10",
      tempWalletPublicKey: validTempWallet,
    });

    expect(custodyStrategy.transfer).toHaveBeenCalledWith({
      from: validTempWallet,
      to: validOwnerAddress,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "95",
      visibility: "private",
      fromBalance: "base",
      toBalance: "ephemeral",
      initIfMissing: true,
      initAtasIfMissing: true,
      initVaultIfMissing: true,
    });
    expect(solanaService.signAndSendSerializedTransaction).toHaveBeenNthCalledWith(
      2,
      "transfer-tx",
      [expect.anything()],
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
      getConnection: jest.fn().mockReturnValue(buildRefundConnection()),
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
        transfer: jest.fn(),
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
      }),
    ).rejects.toMatchObject({
      code: "COMPENSATION_FAILED",
      shouldPauseSwapJob: true,
    } satisfies Partial<FlySwapExecutionFailure>);
  });
});
