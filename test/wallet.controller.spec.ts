import "reflect-metadata";

import { BadRequestException, ValidationPipe } from "@nestjs/common";

import { BalanceDto } from "../src/wallet/dto/balance.dto.js";
import { DepositDto } from "../src/wallet/dto/deposit.dto.js";
import { WithdrawDto } from "../src/wallet/dto/withdraw.dto.js";

describe("WalletController integration", () => {
  const validationPipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  async function validateBody<T>(
    metatype: new () => T,
    value: Record<string, string>,
  ): Promise<T> {
    return validationPipe.transform(value, {
      type: "body",
      metatype,
      data: "",
    }) as Promise<T>;
  }

  it("rejects invalid provider values for deposit", async () => {
    await expect(
      validateBody(DepositDto, {
        provider: "UNKNOWN",
        mint: "So11111111111111111111111111111111111111112",
        amount: "1",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects invalid mint values for balance", async () => {
    await expect(
      validateBody(BalanceDto, {
        provider: "MAGICBLOCK",
        mint: "not-a-solana-address",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects malformed atomic amounts for withdraw", async () => {
    await expect(
      validateBody(WithdrawDto, {
        provider: "MAGICBLOCK",
        mint: "So11111111111111111111111111111111111111112",
        amount: "1.25",
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
