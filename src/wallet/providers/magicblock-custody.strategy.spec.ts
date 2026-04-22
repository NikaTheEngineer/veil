import { jest } from "@jest/globals";
import { BadGatewayException } from "@nestjs/common";

import { MagicBlockCustodyStrategy } from "./magicblock-custody.strategy.js";
import { MagicBlockTeeAuthService } from "./magicblock-tee-auth.service.js";

describe("MagicBlockCustodyStrategy", () => {
  const fetchMock = jest.fn<typeof fetch>();
  const authService: jest.Mocked<
    Pick<MagicBlockTeeAuthService, "getAuthorizationToken">
  > = {
    getAuthorizationToken: jest.fn(),
  };

  let strategy: MagicBlockCustodyStrategy;

  beforeEach(() => {
    const authServiceStub = Object.assign(
      Object.create(MagicBlockTeeAuthService.prototype),
      authService,
    ) as MagicBlockTeeAuthService;
    strategy = new MagicBlockCustodyStrategy(authServiceStub);
    fetchMock.mockReset();
    authService.getAuthorizationToken.mockReset();
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
      writable: true,
    });
  });

  it("builds the deposit request using the env wallet owner", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transactionBase64: "base64-deposit" }), {
        status: 200,
      }),
    );

    const result = await strategy.deposit({
      owner: "owner-address",
      mint: "So11111111111111111111111111111111111111112",
      amount: "42",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://payments.magicblock.app/v1/spl/deposit",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          owner: "owner-address",
          mint: "So11111111111111111111111111111111111111112",
          amount: 42,
        }),
      }),
    );
    expect(result).toEqual({
      transactionBase64: "base64-deposit",
      raw: {
        transactionBase64: "base64-deposit",
      },
    });
  });

  it("builds the withdraw request", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transactionBase64: "base64-withdraw" }), {
        status: 200,
      }),
    );

    const result = await strategy.withdraw({
      owner: "owner-address",
      mint: "So11111111111111111111111111111111111111112",
      amount: "7",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://payments.magicblock.app/v1/spl/withdraw",
      expect.objectContaining({
        body: JSON.stringify({
          owner: "owner-address",
          mint: "So11111111111111111111111111111111111111112",
          amount: 7,
        }),
      }),
    );
    expect(result.transactionBase64).toBe("base64-withdraw");
  });

  it("builds the private transfer request", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transactionBase64: "base64-transfer" }), {
        status: 200,
      }),
    );

    const result = await strategy.transfer({
      from: "from-address",
      to: "to-address",
      mint: "So11111111111111111111111111111111111111112",
      amount: "7",
      visibility: "private",
      fromBalance: "base",
      toBalance: "ephemeral",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://payments.magicblock.app/v1/spl/transfer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          from: "from-address",
          to: "to-address",
          mint: "So11111111111111111111111111111111111111112",
          amount: 7,
          visibility: "private",
          fromBalance: "base",
          toBalance: "ephemeral",
          initIfMissing: true,
          initAtasIfMissing: true,
          initVaultIfMissing: true,
        }),
      }),
    );
    expect(result.transactionBase64).toBe("base64-transfer");
  });

  it("requests private balance with TEE auth", async () => {
    authService.getAuthorizationToken.mockResolvedValue("tee-token");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ balance: "99" }), {
        status: 200,
      }),
    );

    const result = await strategy.getPrivateBalance({
      owner: "owner-address",
      mint: "So11111111111111111111111111111111111111112",
    });

    expect(authService.getAuthorizationToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://payments.magicblock.app/v1/spl/private-balance?address=owner-address&mint=So11111111111111111111111111111111111111112",
      {
        headers: {
          authorization: "Bearer tee-token",
        },
      },
    );
    expect(result).toEqual({ balance: "99" });
  });

  it("wraps downstream failures with provider context", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(
      strategy.deposit({
        owner: "owner-address",
        mint: "So11111111111111111111111111111111111111112",
        amount: "1",
      }),
    ).rejects.toThrow(BadGatewayException);
  });
});
