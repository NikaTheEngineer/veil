import { BadGatewayException, HttpException, Injectable } from "@nestjs/common";
import { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import type { JsonObject, JsonValue } from "../../common/types/json-value.js";
import type {
  CustodyProviderStrategy,
  CustodyTransactionInput,
  CustodyTransferInput,
  PrivateBalanceInput,
  ProviderUnsignedTransaction,
} from "../interfaces/custody-provider.strategy.js";
import { MagicBlockTeeAuthService } from "./magicblock-tee-auth.service.js";

const MAGICBLOCK_SPL_BASE_URL = "https://payments.magicblock.app/v1/spl";

type MagicBlockTransactionResponse = JsonObject & {
  transactionBase64: string;
};

@Injectable()
export class MagicBlockCustodyStrategy implements CustodyProviderStrategy {
  readonly provider = CustodyProvider.MAGICBLOCK;

  constructor(private readonly authService: MagicBlockTeeAuthService) {}

  async deposit(
    input: CustodyTransactionInput,
  ): Promise<ProviderUnsignedTransaction> {
    return this.createTransactionRequest("deposit", input);
  }

  async withdraw(
    input: CustodyTransactionInput,
  ): Promise<ProviderUnsignedTransaction> {
    return this.createTransactionRequest("withdraw", input);
  }

  async transfer(
    input: CustodyTransferInput,
  ): Promise<ProviderUnsignedTransaction> {
    try {
      const raw = await this.readTransactionResponse(
        `${MAGICBLOCK_SPL_BASE_URL}/transfer`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: input.from,
            to: input.to,
            mint: input.mint,
            amount: Number(input.amount),
            visibility: input.visibility,
            fromBalance: input.fromBalance,
            toBalance: input.toBalance,
            initIfMissing: input.initIfMissing ?? true,
            initAtasIfMissing: input.initAtasIfMissing ?? true,
            initVaultIfMissing: input.initVaultIfMissing ?? true,
            ...(input.memo ? { memo: input.memo } : {}),
            ...(input.minDelayMs ? { minDelayMs: input.minDelayMs } : {}),
            ...(input.maxDelayMs ? { maxDelayMs: input.maxDelayMs } : {}),
            ...(input.split ? { split: input.split } : {}),
          }),
        },
      );

      return {
        transactionBase64: raw.transactionBase64,
        raw,
      };
    } catch (error) {
      const normalizedError =
        error instanceof HttpException ||
        error instanceof Error ||
        typeof error === "string"
          ? error
          : String(error);
      throw this.toProviderException("transfer request failed", normalizedError);
    }
  }

  async getPrivateBalance(input: PrivateBalanceInput): Promise<JsonValue> {
    const searchParams = new URLSearchParams({
      address: input.owner,
      mint: input.mint,
    });

    try {
      const authToken = await this.authService.getAuthorizationToken();

      return await this.readJson(
        `${MAGICBLOCK_SPL_BASE_URL}/private-balance?${searchParams.toString()}`,
        {
          headers: {
            authorization: `Bearer ${authToken}`,
          },
        },
      );
    } catch (error) {
      const normalizedError =
        error instanceof HttpException ||
        error instanceof Error ||
        typeof error === "string"
          ? error
          : String(error);
      throw this.toProviderException(
        "private balance request failed",
        normalizedError,
      );
    }
  }

  private async createTransactionRequest(
    action: "deposit" | "withdraw",
    input: CustodyTransactionInput,
  ): Promise<ProviderUnsignedTransaction> {
    try {
      const raw = await this.readTransactionResponse(
        `${MAGICBLOCK_SPL_BASE_URL}/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            owner: input.owner,
            mint: input.mint,
            amount: Number(input.amount),
          }),
        },
      );

      return {
        transactionBase64: raw.transactionBase64,
        raw,
      };
    } catch (error) {
      const normalizedError =
        error instanceof HttpException ||
        error instanceof Error ||
        typeof error === "string"
          ? error
          : String(error);
      throw this.toProviderException(
        `${action} request failed`,
        normalizedError,
      );
    }
  }

  private async readJson(url: string, init?: RequestInit): Promise<JsonValue> {
    const response = await fetch(url, init);
    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `MagicBlock API request failed with HTTP ${response.status}: ${body.slice(0, 1000)}`,
      );
    }

    return JSON.parse(body) as JsonValue;
  }

  private async readTransactionResponse(
    url: string,
    init?: RequestInit,
  ): Promise<MagicBlockTransactionResponse> {
    const payload = await this.readJson(url, init);

    if (
      !this.isJsonObject(payload) ||
      typeof payload.transactionBase64 !== "string" ||
      payload.transactionBase64.length === 0
    ) {
      throw new Error("provider response is missing transactionBase64");
    }

    return payload as MagicBlockTransactionResponse;
  }

  private toProviderException(
    message: string,
    error: Error | HttpException | string,
  ): BadGatewayException {
    if (error instanceof HttpException) {
      return new BadGatewayException(
        `[${this.provider}] ${message}: ${error.message}`,
      );
    }

    const detail = error instanceof Error ? error.message : error;
    return new BadGatewayException(`[${this.provider}] ${message}: ${detail}`);
  }

  private isJsonObject(value: JsonValue): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
