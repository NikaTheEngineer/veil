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
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

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

type SourceFundsLocation = "CUSTODY" | "OWNER" | "TEMP_WALLET" | "SWAPPED";

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
  private readonly tempWalletFundingLamports = 100_000_000n;
  private readonly custodyDepositLamportsTarget = 100_000_000n;
  private readonly lamportFundingVisibilityRetryCount = 10;
  private readonly lamportFundingVisibilityRetryDelayMs = 500;

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
    let sourceFundsLocation: SourceFundsLocation = "CUSTODY";

    try {
      const withdrawSignature = await this.withdrawFromCustody(
        input.custodyProvider,
        input.fromMint,
        input.amount,
        ownerAddress,
      );
      sourceFundsLocation = "OWNER";

      const fundingSignature = await this.fundTempWalletFromOwner(
        tempSigner.publicKey.toBase58(),
        input.fromMint,
        input.amount,
      );
      sourceFundsLocation = "TEMP_WALLET";

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

      const quote = await this.getQuoteAndTransaction({
        fromMint: input.fromMint,
        toMint: input.toMint,
        amount: input.amount,
        slippage: tranche.swapJob.slippage,
        fromAddress: tempSigner.publicKey.toBase58(),
        toAddress: tempSigner.publicKey.toBase58(),
        feePayer: ownerAddress,
      });

      await this.prisma.swapTranche.update({
        where: { id: input.trancheId },
        data: {
          status: SwapTrancheStatus.QUOTE_RECEIVED,
          statusReason: "Fresh Fly quote received",
          quoteId: quote.id,
          quoteTool: this.provider,
        },
      });

      const swapSignature =
        await this.solanaService.signAndSendSerializedTransaction(
          quote.transactionRequestData,
          [this.solanaService.getSigner(), tempSigner],
        );

      await this.prisma.swapTranche.update({
        where: { id: input.trancheId },
        data: {
          status: SwapTrancheStatus.SWAPPED,
          statusReason: "Fly Solana swap submitted and confirmed",
          swapSignature,
          lastError: null,
        },
      });
      sourceFundsLocation = "SWAPPED";
      const settledOutputAmount = await this.getAvailableOutputAmountForDeposit(
        tempSigner.publicKey.toBase58(),
        input.toMint,
        quote.amountOut,
      );

      const custodyStrategy = this.custodyProviderRegistry.get(
        input.custodyProvider,
      );
      const depositPayload = await custodyStrategy.transfer({
        from: tempSigner.publicKey.toBase58(),
        to: ownerAddress,
        mint: input.toMint,
        amount: settledOutputAmount,
        visibility: "private",
        fromBalance: "base",
        toBalance: "ephemeral",
        initIfMissing: true,
        initAtasIfMissing: true,
        initVaultIfMissing: true,
      });
      await this.ensureTempWalletHasLamports(
        tempSigner.publicKey.toBase58(),
        this.custodyDepositLamportsTarget,
      );

      await this.prisma.swapTranche.update({
        where: { id: input.trancheId },
        data: {
          status: SwapTrancheStatus.DEPOSIT_SUBMITTED,
          statusReason:
            "MagicBlock private transfer to ephemeral balance built and submitted",
        },
      });

      const depositSignature =
        await this.solanaService.signAndSendSerializedTransaction(
        depositPayload.transactionBase64,
        [tempSigner],
      );

      await this.prisma.swapTranche.update({
        where: { id: input.trancheId },
        data: {
          status: SwapTrancheStatus.COMPLETED,
          statusReason: "Tranche swap completed and custody deposit submitted",
          depositSignature,
          executedAt: new Date(),
          lastError: null,
        },
      });
    } catch (error) {
      const classifiedFailure = this.classifyExecutionFailure(error);
      const shouldCompensateSourceFunds = sourceFundsLocation !== "SWAPPED";

      if (shouldCompensateSourceFunds) {
        try {
          await this.compensateSourceFunds({
            custodyProvider: input.custodyProvider,
            fromMint: input.fromMint,
            amount: input.amount,
            ownerAddress,
            tempSigner,
            sourceFundsLocation,
            executionMode: tranche.swapJob.executionMode as SwapExecutionMode,
          });
        } catch (compensationError) {
          const detail =
            compensationError instanceof Error
              ? compensationError.message
              : String(compensationError);
          const failureContext = classifiedFailure
            ? classifiedFailure.message.toLowerCase()
            : "execution failure";
          throw new FlySwapExecutionFailure(
            `Compensation failed after ${failureContext}: ${detail}`,
            "COMPENSATION_FAILED",
            tranche.swapJob.executionMode !== SwapExecutionMode.INSTANT,
          );
        }
      }

      if (!classifiedFailure) {
        throw error;
      }

      const refundMessage = shouldCompensateSourceFunds
        ? sourceFundsLocation === "CUSTODY"
          ? "Source funds remained in MagicBlock custody."
          : "Source funds were returned to MagicBlock custody."
        : "The swap had already executed, so the source asset could not be refunded.";
      throw new FlySwapExecutionFailure(
        `${classifiedFailure.message}. ${refundMessage}`,
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
      const lamports = BigInt(amount) + this.tempWalletFundingLamports;
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
        lamports: this.tempWalletFundingLamports,
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
    feePayer: string;
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

  private async getAvailableOutputAmountForDeposit(
    tempWalletAddress: string,
    mint: string,
    fallbackAmount: string,
  ): Promise<string> {
    if (mint === this.nativeSolMint) {
      return fallbackAmount;
    }

    const connection = this.solanaService.getConnection();
    const tempAta = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      new PublicKey(tempWalletAddress),
    );
    const balance = await connection.getTokenAccountBalance(tempAta);
    const amount = balance.value.amount;

    if (!amount || amount === "0") {
      throw new BadGatewayException(
        "Swap completed but temp wallet output token balance is empty",
      );
    }

    return amount;
  }

  private async ensureTempWalletHasLamports(
    tempWalletAddress: string,
    minimumLamports: bigint,
  ): Promise<void> {
    const connection = this.solanaService.getConnection();
    const tempWalletPublicKey = new PublicKey(tempWalletAddress);
    let currentLamports = BigInt(
      await connection.getBalance(tempWalletPublicKey),
    );

    if (currentLamports >= minimumLamports) {
      return;
    }

    await this.solanaService.transferLamports(
      tempWalletAddress,
      minimumLamports - currentLamports,
    );

    for (
      let attempt = 0;
      attempt < this.lamportFundingVisibilityRetryCount;
      attempt += 1
    ) {
      currentLamports = BigInt(await connection.getBalance(tempWalletPublicKey));

      if (currentLamports >= minimumLamports) {
        return;
      }

      await this.sleep(this.lamportFundingVisibilityRetryDelayMs);
    }

    throw new BadGatewayException(
      `Temp wallet SOL top-up was not visible on-chain before custody execution. Current balance: ${currentLamports.toString()} lamports, required: ${minimumLamports.toString()} lamports.`,
    );
  }

  private async sleep(durationMs: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }

  private async getQuote(input: {
    fromMint: string;
    toMint: string;
    amount: string;
    slippage: string;
    fromAddress: string;
    toAddress: string;
    feePayer: string;
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
      feePayer: input.feePayer,
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

  private async compensateSourceFunds(input: {
    custodyProvider: ReadySwapTrancheInput["custodyProvider"];
    fromMint: string;
    amount: string;
    ownerAddress: string;
    tempSigner: ReturnType<SolanaService["decodeBase64SecretKey"]>;
    sourceFundsLocation: SourceFundsLocation;
    executionMode: SwapExecutionMode;
  }): Promise<void> {
    switch (input.sourceFundsLocation) {
      case "CUSTODY":
        return;
      case "OWNER":
        await this.depositBackIntoCustody(
          input.custodyProvider,
          input.fromMint,
          input.amount,
          input.ownerAddress,
        );
        return;
      case "TEMP_WALLET":
        await this.returnFundsFromTempWallet(
          input.tempSigner,
          input.ownerAddress,
          input.fromMint,
        );
        await this.depositBackIntoCustody(
          input.custodyProvider,
          input.fromMint,
          input.amount,
          input.ownerAddress,
        );
        return;
      case "SWAPPED":
        return;
    }
  }

  private async returnFundsFromTempWallet(
    tempSigner: ReturnType<SolanaService["decodeBase64SecretKey"]>,
    ownerAddress: string,
    fromMint: string,
  ): Promise<void> {
    if (fromMint === this.nativeSolMint) {
      await this.drainTempWalletLamports(tempSigner, ownerAddress);
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
        BigInt(await connection.getTokenAccountBalance(tempAta).then((result) => result.value.amount)),
      ),
      createCloseAccountInstruction(
        tempAta,
        ownerPublicKey,
        tempWalletPublicKey,
      ),
    );

    await this.solanaService.sendInstructions(instructions, tempSigner);
    await this.drainTempWalletLamports(tempSigner, ownerAddress);
  }

  private async depositBackIntoCustody(
    custodyProvider: ReadySwapTrancheInput["custodyProvider"],
    mint: string,
    amount: string,
    ownerAddress: string,
  ): Promise<void> {
    const custodyStrategy = this.custodyProviderRegistry.get(custodyProvider);
    const depositPayload = await custodyStrategy.deposit({
      owner: ownerAddress,
      mint,
      amount,
    });

    await this.solanaService.signAndSendTransaction(
      depositPayload.transactionBase64,
    );
  }

  private async drainTempWalletLamports(
    tempSigner: ReturnType<SolanaService["decodeBase64SecretKey"]>,
    ownerAddress: string,
  ): Promise<void> {
    const connection = this.solanaService.getConnection();
    const balance = await connection.getBalance(tempSigner.publicKey);

    if (balance <= 0) {
      return;
    }

    const destination = new PublicKey(ownerAddress);
    const feeEstimate = await this.estimateDrainFee(
      tempSigner.publicKey,
      destination,
    );
    const transferableLamports = balance - feeEstimate;

    if (transferableLamports <= 0) {
      return;
    }

    await this.solanaService.sendInstructions(
      [
        SystemProgram.transfer({
          fromPubkey: tempSigner.publicKey,
          toPubkey: destination,
          lamports: transferableLamports,
        }),
      ],
      tempSigner,
    );
  }

  private async estimateDrainFee(
    fromPubkey: PublicKey,
    toPubkey: PublicKey,
  ): Promise<number> {
    try {
      const connection = this.solanaService.getConnection();
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey,
          toPubkey,
          lamports: 1,
        }),
      );
      transaction.feePayer = fromPubkey;
      transaction.recentBlockhash = (
        await connection.getLatestBlockhash()
      ).blockhash;

      const fee = await transaction.getEstimatedFee(connection);

      if (fee !== null) {
        return fee;
      }
    } catch {
      // Fallback keeps the refund path alive when fee estimation is unavailable.
    }

    return 10_000;
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
