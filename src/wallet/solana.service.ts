import { Injectable, InternalServerErrorException } from "@nestjs/common";
import {
  type Commitment,
  Connection,
  type ConnectionConfig,
  Keypair,
  PublicKey,
  type SendOptions,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  type TransactionInstruction,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

const DEFAULT_COMMITMENT: Commitment = "confirmed";

@Injectable()
export class SolanaService {
  getSigner(): Keypair {
    const privateKey = this.requireEnv("SOLANA_PRIVATE_KEY");

    try {
      return Keypair.fromSecretKey(bs58.decode(privateKey));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        `Failed to decode SOLANA_PRIVATE_KEY: ${detail}`,
      );
    }
  }

  getPublicKey(): string {
    return this.getSigner().publicKey.toBase58();
  }

  getConnection(): Connection {
    const rpcUrl = this.requireEnv("SOLANA_RPC_URL");
    const wsUrl = process.env.SOLANA_WS_URL?.trim();
    const { endpoint, config } = this.buildConnectionOptions(rpcUrl, wsUrl);
    return new Connection(endpoint, config);
  }

  decodeBase64SecretKey(secretBase64: string): Keypair {
    try {
      return Keypair.fromSecretKey(Buffer.from(secretBase64, "base64"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        `Failed to decode temp wallet secret: ${detail}`,
      );
    }
  }

  async signAndSendTransaction(transactionBase64: string): Promise<string> {
    return this.signAndSendSerializedTransaction(transactionBase64, [
      this.getSigner(),
    ]);
  }

  async signAndSendSerializedTransaction(
    transactionBase64: string,
    signers: Keypair[],
    options?: SendOptions,
  ): Promise<string> {
    const connection = this.getConnection();
    const serialized = Buffer.from(transactionBase64, "base64");

    try {
      const signedTransaction = this.deserializeAndSignTransaction(
        serialized,
        signers,
      );

      if (signedTransaction.kind === "legacy") {
        const signature = await connection.sendRawTransaction(
          signedTransaction.transaction.serialize(),
          {
            skipPreflight: false,
            ...(options ?? {}),
          },
        );
        await connection.confirmTransaction(signature, DEFAULT_COMMITMENT);
        return signature;
      }

      const signature = await connection.sendTransaction(
        signedTransaction.transaction,
        {
          skipPreflight: false,
          ...(options ?? {}),
        },
      );
      await connection.confirmTransaction(signature, DEFAULT_COMMITMENT);
      return signature;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        `Failed to sign and send serialized transaction: ${detail}`,
      );
    }
  }

  getPublicKeyInstance(): PublicKey {
    return this.getSigner().publicKey;
  }

  async transferLamports(
    toAddress: string,
    lamports: number | bigint,
  ): Promise<string> {
    return this.sendInstructions(
      [
        SystemProgram.transfer({
          fromPubkey: this.getSigner().publicKey,
          toPubkey: new PublicKey(toAddress),
          lamports,
        }),
      ],
      this.getSigner(),
    );
  }

  async sendInstructions(
    instructions: TransactionInstruction[],
    signer: Keypair,
  ): Promise<string> {
    const connection = this.getConnection();
    const transaction = new Transaction().add(...instructions);
    transaction.feePayer = signer.publicKey;

    try {
      return await sendAndConfirmTransaction(
        connection,
        transaction,
        [signer],
        {
          commitment: DEFAULT_COMMITMENT,
          skipPreflight: false,
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        `Failed to send Solana instruction transaction: ${detail}`,
      );
    }
  }

  private requireEnv(name: string): string {
    const value = process.env[name]?.trim();

    if (!value) {
      throw new InternalServerErrorException(
        `Missing required environment variable: ${name}`,
      );
    }

    return value;
  }

  private buildConnectionOptions(rpcUrl: string, wsUrl?: string): {
    endpoint: string;
    config: ConnectionConfig;
  } {
    const url = new URL(rpcUrl);
    const headers: Record<string, string> = {};

    if (url.username || url.password) {
      const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      headers.authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
      url.username = "";
      url.password = "";
    }

    return {
      endpoint: url.toString(),
      config: {
        commitment: DEFAULT_COMMITMENT,
        ...(wsUrl ? { wsEndpoint: wsUrl } : {}),
        ...(Object.keys(headers).length > 0 ? { httpHeaders: headers } : {}),
      },
    };
  }

  private deserializeAndSignTransaction(
    serialized: Buffer,
    signers: Keypair[],
  ):
    | { kind: "legacy"; transaction: Transaction }
    | { kind: "versioned"; transaction: VersionedTransaction } {
    const parseErrors: string[] = [];

    try {
      const transaction = VersionedTransaction.deserialize(serialized);
      transaction.sign(signers);
      return { kind: "versioned", transaction };
    } catch (error) {
      parseErrors.push(
        `versioned transaction: ${this.formatParseFailure(error)}`,
      );
    }

    try {
      const transaction = Transaction.from(serialized);
      for (const signer of signers) {
        transaction.partialSign(signer);
      }
      return { kind: "legacy", transaction };
    } catch (error) {
      parseErrors.push(`legacy transaction: ${this.formatParseFailure(error)}`);
    }

    try {
      const message = VersionedMessage.deserialize(serialized);
      const transaction = new VersionedTransaction(message);
      transaction.sign(signers);
      return { kind: "versioned", transaction };
    } catch (error) {
      parseErrors.push(`versioned message: ${this.formatParseFailure(error)}`);
    }

    throw new Error(
      `Unsupported serialized transaction payload (${parseErrors.join("; ")})`,
    );
  }

  private formatParseFailure(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
