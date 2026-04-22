import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { SwapTrancheStatus } from "@prisma/client";
import {
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { SwapExecutionMode } from "../../common/enums/swap-execution-mode.enum.js";
import { SwapProvider } from "../../common/enums/swap-provider.enum.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { TempWalletCryptoService } from "../../swap/services/temp-wallet-crypto.service.js";
import type {
  ReadySwapTrancheInput,
  SwapExecutionPreparationInput,
  SwapProviderStrategy,
} from "../interfaces/swap-provider.strategy.js";
import { SolanaService } from "../solana.service.js";
import { CustodyProviderRegistry } from "./custody-provider.registry.js";

interface FlyQuotePayload {
  id?: string;
  amountOut?: string;
}

interface FlyTransactionPayload {
  data?: string;
}

type ClassifiedExecutionFailure =
  | "QUOTE_EXPIRED"
  | "SLIPPAGE_EXCEEDED"
  | "COMPENSATION_FAILED";

export class FlySwapExecutionFailure extends Error {
  constructor(
    message: string,
    readonly code: ClassifiedExecutionFailure,
    readonly shouldPauseSwapJob: boolean,
  ) {
    super(message);
  }
}

@Injectable()
export class FlySwapStrategy implements SwapProviderStrategy {
  readonly provider = SwapProvider.FLY;
  private readonly apiBaseUrl = "https://api.magpiefi.io";
  private readonly network = "solana";
  private readonly nativeSolMint = "11111111111111111111111111111111";
  private readonly feeBufferLamports = 1_500_000n;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tempWalletCryptoService: TempWalletCryptoService,
    private readonly solanaService: SolanaService,
    private readonly custodyProviderRegistry: CustodyProviderRegistry,
  ) {}

  async prepareExecution(_input: SwapExecutionPreparationInput): Promise<void> {
    this.solanaService.getSigner();
    return;
  }

  async markTrancheReady(input: ReadySwapTrancheInput): Promise<void> {
    const tranche = await this.prisma.swapTranche.findUnique({
      where: { id: input.trancheId },
      include: { swapJob: true },
    });

    if (!tranche) {
      throw new NotFoundException(`Swap tranche not found: ${input.trancheId}`);
    }

    const decryptedSecret = this.tempWalletCryptoService.decryptSecret(
      tranche.encryptedTempWalletSecret,
      tranche.tempWalletEncryptionIv,
      tranche.tempWalletEncryptionAuthTag,
    );
    const tempSigner =
      this.solanaService.decodeBase64SecretKey(decryptedSecret);

    if (tempSigner.publicKey.toBase58() !== input.tempWalletPublicKey) {
      throw new InternalServerErrorException(
        "Decrypted temp wallet does not match persisted public key",
      );
    }

    const ownerAddress = this.solanaService.getPublicKey();
    const withdrawSignature = await this.withdrawFromCustody(
      input.custodyProvider,
      input.fromMint,
      input.amount,
      ownerAddress,
    );
    const fundingSignature = await this.fundTempWalletFromOwner(
      tempSigner.publicKey.toBase58(),
      input.fromMint,
      input.amount,
    );
    await this.prisma.swapTranche.update({
      where: { id: input.trancheId },
      data: {
        status: SwapTrancheStatus.FUNDED,
        statusReason:
          "Custody withdrew tranche funds and temp wallet was funded for Fly execution",
        withdrawSignature,
        fundingSignature,
      },
    });

    try {
      const quote = input.preloadedQuote
        ? {
            id: input.preloadedQuote.quoteId,
            amountOut: input.preloadedQuote.amountOut,
            transactionRequestData: await this.getTransactionPayload(
              input.preloadedQuote.quoteId,
            ),
          }
        : await this.getQuoteAndTransaction({
            fromMint: input.fromMint,
            toMint: input.toMint,
            amount: input.amount,
            slippage: tranche.swapJob.slippage,
            fromAddress: tempSigner.publicKey.toBase58(),
            toAddress: ownerAddress,
          });

      await this.prisma.swapTranche.update({
        where: { id: input.trancheId },
        data: {
          status: SwapTrancheStatus.QUOTE_RECEIVED,
          statusReason: input.preloadedQuote
            ? "Fly quote supplied by instant swap request"
            : "Fresh Fly quote received",
          quoteId: quote.id,
          quoteTool: this.provider,
        },
      });

      const swapSignature =
        await this.solanaService.signAndSendSerializedTransaction(
          quote.transactionRequestData,
          [tempSigner],
        );

      await this.prisma.swapTranche.update({
        where: { id: input.trancheId },
        data: {
          status: SwapTrancheStatus.SWAPPED,
          statusReason: "Fly Solana swap submitted and confirmed",
          swapSignature,
        },
      });

      const custodyStrategy = this.custodyProviderRegistry.get(
        input.custodyProvider,
      );
      const depositPayload = await custodyStrategy.deposit({
        owner: ownerAddress,
        mint: input.toMint,
        amount: quote.amountOut,
      });

      await this.prisma.swapTranche.update({
        where: { id: input.trancheId },
        data: {
          status: SwapTrancheStatus.DEPOSIT_SUBMITTED,
          statusReason: "MagicBlock deposit transaction built and submitted",
        },
      });

      const depositSignature = await this.solanaService.signAndSendTransaction(
        depositPayload.transactionBase64,
      );

      await this.prisma.swapTranche.update({
        where: { id: input.trancheId },
        data: {
          status: SwapTrancheStatus.COMPLETED,
          statusReason: "Tranche swap completed and custody deposit submitted",
          depositSignature,
          executedAt: new Date(),
        },
      });
    } catch (error) {
      const classifiedFailure = this.classifyExecutionFailure(error);
      if (!classifiedFailure) {
        throw error;
      }

      try {
        await this.compensateUnswappedSourceFunds({
          custodyProvider: input.custodyProvider,
          fromMint: input.fromMint,
          amount: input.amount,
          ownerAddress,
          tempSigner,
        });
      } catch (compensationError) {
        const detail =
          compensationError instanceof Error
            ? compensationError.message
            : String(compensationError);
        throw new FlySwapExecutionFailure(
          `Compensation failed after ${classifiedFailure.message.toLowerCase()}: ${detail}`,
          "COMPENSATION_FAILED",
          tranche.swapJob.executionMode !== SwapExecutionMode.INSTANT,
        );
      }

      throw new FlySwapExecutionFailure(
        `${classifiedFailure.message}. Source funds were returned to custody.`,
        classifiedFailure.code,
        tranche.swapJob.executionMode !== SwapExecutionMode.INSTANT,
      );
    }
  }

  private async withdrawFromCustody(
    custodyProvider: ReadySwapTrancheInput["custodyProvider"],
    mint: string,
    amount: string,
    owner: string,
  ): Promise<string> {
    const custodyStrategy = this.custodyProviderRegistry.get(custodyProvider);
    const withdrawPayload = await custodyStrategy.withdraw({
      owner,
      mint,
      amount,
    });

    return this.solanaService.signAndSendTransaction(
      withdrawPayload.transactionBase64,
    );
  }

  private async fundTempWalletFromOwner(
    tempWalletAddress: string,
    fromMint: string,
    amount: string,
  ): Promise<string> {
    const envSigner = this.solanaService.getSigner();
    const ownerAddress = envSigner.publicKey;

    if (fromMint === this.nativeSolMint) {
      const lamports = BigInt(amount) + this.feeBufferLamports;
      return this.solanaService.transferLamports(tempWalletAddress, lamports);
    }

    const tempWalletPublicKey = new PublicKey(tempWalletAddress);
    const mint = new PublicKey(fromMint);
    const ownerAta = getAssociatedTokenAddressSync(mint, ownerAddress);
    const tempAta = getAssociatedTokenAddressSync(mint, tempWalletPublicKey);
    const connection = this.solanaService.getConnection();
    const tempAtaInfo = await connection.getAccountInfo(tempAta);
    const instructions = [
      SystemProgram.transfer({
        fromPubkey: ownerAddress,
        toPubkey: tempWalletPublicKey,
        lamports: this.feeBufferLamports,
      }),
    ];

    if (!tempAtaInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          ownerAddress,
          tempAta,
          tempWalletPublicKey,
          mint,
        ),
      );
    }

    instructions.push(
      createTransferInstruction(
        ownerAta,
        tempAta,
        ownerAddress,
        BigInt(amount),
      ),
    );

    return this.solanaService.sendInstructions(instructions, envSigner);
  }

  private async getQuoteAndTransaction(input: {
    fromMint: string;
    toMint: string;
    amount: string;
    slippage: string;
    fromAddress: string;
    toAddress: string;
  }): Promise<{
    id: string;
    amountOut: string;
    transactionRequestData: string;
  }> {
    const quote = await this.getQuote(input);
    const transactionRequestData = await this.getTransactionPayload(quote.id);

    return {
      id: quote.id,
      amountOut: quote.amountOut,
      transactionRequestData,
    };
  }

  private async getQuote(input: {
    fromMint: string;
    toMint: string;
    amount: string;
    slippage: string;
    fromAddress: string;
    toAddress: string;
  }): Promise<{
    id: string;
    amountOut: string;
  }> {
    const searchParams = new URLSearchParams({
      network: this.network,
      fromTokenAddress: input.fromMint,
      toTokenAddress: input.toMint,
      sellAmount: input.amount,
      slippage: input.slippage,
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      gasless: "false",
    });

    const response = await fetch(
      `${this.apiBaseUrl}/aggregator/quote?${searchParams.toString()}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      },
    );
    const bodyText = await response.text();

    if (!response.ok) {
      throw new BadGatewayException(
        `Fly quote request failed with HTTP ${response.status}: ${bodyText.slice(0, 1000)}`,
      );
    }

    const payload = this.parseJsonPayload<FlyQuotePayload>(bodyText);
    if (
      typeof payload.id !== "string" ||
      payload.id.length === 0 ||
      typeof payload.amountOut !== "string" ||
      payload.amountOut.length === 0
    ) {
      throw new BadGatewayException(
        "Fly quote response did not include id and amountOut",
      );
    }

    return {
      id: payload.id,
      amountOut: payload.amountOut,
    };
  }

  private classifyExecutionFailure(error: unknown): {
    code: Exclude<ClassifiedExecutionFailure, "COMPENSATION_FAILED">;
    message: string;
  } | null {
    const detail = error instanceof Error ? error.message : String(error);
    const normalized = detail.toLowerCase();

    if (
      normalized.includes("quote") &&
      (normalized.includes("expired") ||
        normalized.includes("invalid") ||
        normalized.includes("not found") ||
        normalized.includes("consumed"))
    ) {
      return {
        code: "QUOTE_EXPIRED",
        message: "Quote expired before execution",
      };
    }

    if (
      normalized.includes("slippage") ||
      normalized.includes("amountoutmin") ||
      normalized.includes("minimum received") ||
      normalized.includes("price impact") ||
      normalized.includes("too little received") ||
      normalized.includes("outside tolerance")
    ) {
      return {
        code: "SLIPPAGE_EXCEEDED",
        message:
          "Execution failed because market pricing moved outside slippage tolerance",
      };
    }

    return null;
  }

  private async compensateUnswappedSourceFunds(input: {
    custodyProvider: ReadySwapTrancheInput["custodyProvider"];
    fromMint: string;
    amount: string;
    ownerAddress: string;
    tempSigner: ReturnType<SolanaService["decodeBase64SecretKey"]>;
  }): Promise<void> {
    await this.returnFundsFromTempWallet(
      input.tempSigner,
      input.ownerAddress,
      input.fromMint,
      input.amount,
    );

    const custodyStrategy = this.custodyProviderRegistry.get(
      input.custodyProvider,
    );
    const depositPayload = await custodyStrategy.deposit({
      owner: input.ownerAddress,
      mint: input.fromMint,
      amount: input.amount,
    });

    await this.solanaService.signAndSendTransaction(
      depositPayload.transactionBase64,
    );
  }

  private async returnFundsFromTempWallet(
    tempSigner: ReturnType<SolanaService["decodeBase64SecretKey"]>,
    ownerAddress: string,
    fromMint: string,
    amount: string,
  ): Promise<void> {
    if (fromMint === this.nativeSolMint) {
      await this.solanaService.sendInstructions(
        [
          SystemProgram.transfer({
            fromPubkey: tempSigner.publicKey,
            toPubkey: new PublicKey(ownerAddress),
            lamports: BigInt(amount),
          }),
        ],
        tempSigner,
      );
      return;
    }

    const connection = this.solanaService.getConnection();
    const tempWalletPublicKey = tempSigner.publicKey;
    const ownerPublicKey = new PublicKey(ownerAddress);
    const mint = new PublicKey(fromMint);
    const tempAta = getAssociatedTokenAddressSync(mint, tempWalletPublicKey);
    const ownerAta = getAssociatedTokenAddressSync(mint, ownerPublicKey);
    const ownerAtaInfo = await connection.getAccountInfo(ownerAta);
    const instructions = [];

    if (!ownerAtaInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          tempWalletPublicKey,
          ownerAta,
          ownerPublicKey,
          mint,
        ),
      );
    }

    instructions.push(
      createTransferInstruction(
        tempAta,
        ownerAta,
        tempWalletPublicKey,
        BigInt(amount),
      ),
      createCloseAccountInstruction(
        tempAta,
        tempWalletPublicKey,
        tempWalletPublicKey,
      ),
    );

    await this.solanaService.sendInstructions(instructions, tempSigner);
  }

  private async getTransactionPayload(quoteId: string): Promise<string> {
    const searchParams = new URLSearchParams({ quoteId });
    const response = await fetch(
      `${this.apiBaseUrl}/aggregator/transaction?${searchParams.toString()}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      },
    );
    const bodyText = await response.text();

    if (!response.ok) {
      throw new BadGatewayException(
        `Fly transaction request failed with HTTP ${response.status}: ${bodyText.slice(0, 1000)}`,
      );
    }

    const payload = this.parseJsonPayload<FlyTransactionPayload>(bodyText);
    if (typeof payload.data !== "string" || payload.data.length === 0) {
      throw new BadGatewayException(
        "Fly transaction response did not include serialized transaction data",
      );
    }

    return payload.data;
  }

  private parseJsonPayload<T>(bodyText: string): T {
    try {
      return JSON.parse(bodyText) as T;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BadGatewayException(
        `Fly response was not valid JSON: ${detail}`,
      );
    }
  }
}
