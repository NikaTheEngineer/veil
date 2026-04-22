import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { Keypair } from "@solana/web3.js";

export interface EncryptedTempWallet {
  publicKey: string;
  encryptedSecret: string;
  iv: string;
  authTag: string;
  algorithm: string;
}

@Injectable()
export class TempWalletCryptoService {
  private readonly algorithm = "aes-256-gcm";

  createEncryptedTempWallet(): EncryptedTempWallet {
    const keypair = Keypair.generate();
    const plaintextSecret = Buffer.from(keypair.secretKey).toString("base64");
    const encrypted = this.encryptString(plaintextSecret);

    return {
      publicKey: keypair.publicKey.toBase58(),
      encryptedSecret: encrypted.encryptedSecret,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      algorithm: this.algorithm,
    };
  }

  decryptSecret(encryptedSecret: string, iv: string, authTag: string): string {
    const decipher = createDecipheriv(
      this.algorithm,
      this.getMasterKey(),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(authTag, "base64"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedSecret, "base64")),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  }

  private encryptString(plaintext: string): {
    encryptedSecret: string;
    iv: string;
    authTag: string;
  } {
    const iv = randomBytes(12);
    const cipher = createCipheriv(this.algorithm, this.getMasterKey(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return {
      encryptedSecret: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
    };
  }

  private getMasterKey(): Buffer {
    const rawKey = process.env.TEMP_WALLET_ENCRYPTION_KEY?.trim();

    if (!rawKey) {
      throw new InternalServerErrorException(
        "Missing required environment variable: TEMP_WALLET_ENCRYPTION_KEY",
      );
    }

    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      return Buffer.from(rawKey, "hex");
    }

    const base64Buffer = Buffer.from(rawKey, "base64");
    if (base64Buffer.length === 32) {
      return base64Buffer;
    }

    throw new InternalServerErrorException(
      "TEMP_WALLET_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hex value",
    );
  }
}
