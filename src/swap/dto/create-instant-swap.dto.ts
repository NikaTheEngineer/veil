import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, Matches } from "class-validator";

import { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import { SwapProvider } from "../../common/enums/swap-provider.enum.js";
import { IsAtomicAmountString } from "../../common/validators/is-atomic-amount-string.decorator.js";
import { IsSolanaAddress } from "../../common/validators/is-solana-address.decorator.js";

export class CreateInstantSwapDto {
  @ApiProperty({
    enum: CustodyProvider,
    enumName: "CustodyProvider",
    example: CustodyProvider.MAGICBLOCK,
  })
  @IsEnum(CustodyProvider)
  custodyProvider!: CustodyProvider;

  @ApiProperty({
    enum: SwapProvider,
    enumName: "SwapProvider",
    example: SwapProvider.FLY,
  })
  @IsEnum(SwapProvider)
  swapProvider!: SwapProvider;

  @ApiProperty({
    example: "So11111111111111111111111111111111111111112",
    description: "Source token mint address on Solana",
  })
  @IsSolanaAddress()
  fromMint!: string;

  @ApiProperty({
    example: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    description: "Destination token mint address on Solana",
  })
  @IsSolanaAddress()
  toMint!: string;

  @ApiProperty({
    example: "1000000",
    description: "Source amount in atomic units as a string",
  })
  @IsAtomicAmountString()
  fromAmount!: string;

  @ApiProperty({
    example: "0.005",
    description:
      "Maximum acceptable slippage as a decimal string (for example 0.005 for 0.5%)",
  })
  @Matches(/^(0|0?\.\d+|1(?:\.0+)?)$/, {
    message: "slippage must be a decimal string between 0 and 1 inclusive",
  })
  slippage!: string;
}
