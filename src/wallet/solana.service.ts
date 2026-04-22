import { Injectable, InternalServerErrorException } from "@nestjs/common";
import {
  type Commitment,
  Connection,
  Keypair,
  PublicKey,
  type SendOptions,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  type TransactionInstruction,
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
    return new Connection(
      this.requireEnv("SOLANA_RPC_URL"),
      DEFAULT_COMMITMENT,
    );
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
      try {
        const versionedTransaction =
          VersionedTransaction.deserialize(serialized);
        versionedTransaction.sign(signers);
        const signature = await connection.sendTransaction(
          versionedTransaction,
          {
            skipPreflight: false,
            ...(options ?? {}),
          },
        );
        await connection.confirmTransaction(signature, DEFAULT_COMMITMENT);
        return signature;
      } catch {
        const transaction = Transaction.from(serialized);
        for (const signer of signers) {
          transaction.partialSign(signer);
        }

        const signature = await connection.sendRawTransaction(
          transaction.serialize(),
          {
            skipPreflight: false,
            ...(options ?? {}),
          },
        );
        await connection.confirmTransaction(signature, DEFAULT_COMMITMENT);
        return signature;
      }
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
}
