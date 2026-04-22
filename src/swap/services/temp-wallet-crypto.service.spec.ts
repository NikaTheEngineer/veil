import { randomBytes } from "node:crypto";
import { InternalServerErrorException } from "@nestjs/common";

import { TempWalletCryptoService } from "./temp-wallet-crypto.service.js";

describe("TempWalletCryptoService", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      TEMP_WALLET_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("encrypts and decrypts temp wallet secrets", () => {
    const service = new TempWalletCryptoService();
    const wallet = service.createEncryptedTempWallet();

    const decrypted = service.decryptSecret(
      wallet.encryptedSecret,
      wallet.iv,
      wallet.authTag,
    );

    expect(wallet.publicKey).toBeTruthy();
    expect(wallet.algorithm).toBe("aes-256-gcm");
    expect(typeof decrypted).toBe("string");
    expect(decrypted.length).toBeGreaterThan(0);
  });

  it("fails when the master key is missing", () => {
    delete process.env.TEMP_WALLET_ENCRYPTION_KEY;
    const service = new TempWalletCryptoService();

    expect(() => service.createEncryptedTempWallet()).toThrow(
      InternalServerErrorException,
    );
  });
});
