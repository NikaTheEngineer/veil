import {
  getAuthToken,
  verifyTeeRpcIntegrity,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import nacl from "tweetnacl";

import { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import { SolanaService } from "../solana.service.js";

const DEFAULT_TEE_URL = "https://mainnet-tee.magicblock.app";

@Injectable()
export class MagicBlockTeeAuthService {
  constructor(private readonly solanaService: SolanaService) {}

  async getAuthorizationToken(): Promise<string> {
    const teeUrl = process.env.MAGICBLOCK_TEE_URL?.trim() || DEFAULT_TEE_URL;
    const signer = this.solanaService.getSigner();

    try {
      await verifyTeeRpcIntegrity(teeUrl);

      const { token } = await getAuthToken(
        teeUrl,
        signer.publicKey,
        (message: Uint8Array) =>
          Promise.resolve(nacl.sign.detached(message, signer.secretKey)),
      );

      return token;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(
        `[${CustodyProvider.MAGICBLOCK}] Failed to acquire TEE authorization token: ${detail}`,
      );
    }
  }
}
