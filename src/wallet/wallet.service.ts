import { BadRequestException, Injectable } from "@nestjs/common";

import { WalletAction } from "../common/enums/wallet-action.enum.js";
import type { JsonObject, JsonValue } from "../common/types/json-value.js";
import type { BalanceDto } from "./dto/balance.dto.js";
import type { DepositDto } from "./dto/deposit.dto.js";
import type { WithdrawDto } from "./dto/withdraw.dto.js";
import type {
  WalletBalanceResponse,
  WalletTransactionResponse,
} from "./interfaces/wallet-response.js";
import { CustodyProviderRegistry } from "./providers/custody-provider.registry.js";
import { SolanaService } from "./solana.service.js";

@Injectable()
export class WalletService {
  constructor(
    private readonly custodyProviderRegistry: CustodyProviderRegistry,
    private readonly solanaService: SolanaService,
  ) {}

  async deposit(dto: DepositDto): Promise<WalletTransactionResponse> {
    return this.executeTransaction(
      WalletAction.DEPOSIT,
      dto.provider,
      dto.mint,
      dto.amount,
    );
  }

  async withdraw(dto: WithdrawDto): Promise<WalletTransactionResponse> {
    await this.assertSufficientBalance(dto.provider, dto.mint, dto.amount);

    return this.executeTransaction(
      WalletAction.WITHDRAW,
      dto.provider,
      dto.mint,
      dto.amount,
    );
  }

  async balance(dto: BalanceDto): Promise<WalletBalanceResponse> {
    const strategy = this.custodyProviderRegistry.get(dto.provider);
    const owner = this.solanaService.getPublicKey();
    const data = await strategy.getPrivateBalance({
      owner,
      mint: dto.mint,
    });

    return {
      provider: dto.provider,
      owner,
      mint: dto.mint,
      data,
    };
  }

  private async executeTransaction(
    action: WalletAction,
    provider: DepositDto["provider"],
    mint: string,
    amount: string,
  ): Promise<WalletTransactionResponse> {
    const strategy = this.custodyProviderRegistry.get(provider);
    const owner = this.solanaService.getPublicKey();

    const providerPayload =
      action === WalletAction.DEPOSIT
        ? await strategy.deposit({ owner, mint, amount })
        : await strategy.withdraw({ owner, mint, amount });

    const signature = await this.solanaService.signAndSendTransaction(
      providerPayload.transactionBase64,
    );

    return {
      provider,
      action,
      owner,
      mint,
      amount,
      signature,
      providerPayload: {
        transactionBase64: providerPayload.transactionBase64,
      },
    };
  }

  private async assertSufficientBalance(
    provider: DepositDto["provider"],
    mint: string,
    amount: string,
  ): Promise<void> {
    const strategy = this.custodyProviderRegistry.get(provider);
    const owner = this.solanaService.getPublicKey();
    const balancePayload = await strategy.getPrivateBalance({
      owner,
      mint,
    });

    const availableBalance = this.extractAtomicBalance(balancePayload, provider);
    const requestedAmount = BigInt(amount);

    if (availableBalance < requestedAmount) {
      throw new BadRequestException(
        `[${provider}] insufficient private balance: requested ${amount}, available ${availableBalance.toString()}`,
      );
    }
  }

  private extractAtomicBalance(
    payload: JsonValue,
    provider: DepositDto["provider"],
  ): bigint {
    if (!this.isJsonObject(payload) || typeof payload.balance !== "string") {
      throw new BadRequestException(
        `[${provider}] private balance response is missing a string balance field`,
      );
    }

    try {
      return BigInt(payload.balance);
    } catch {
      throw new BadRequestException(
        `[${provider}] private balance response contains an invalid balance value`,
      );
    }
  }

  private isJsonObject(value: JsonValue): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
