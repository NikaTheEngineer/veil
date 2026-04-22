import { ApiProperty } from "@nestjs/swagger";
import { IsEnum } from "class-validator";

import { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import { IsSolanaAddress } from "../../common/validators/is-solana-address.decorator.js";

export class BalanceDto {
  @ApiProperty({
    enum: CustodyProvider,
    enumName: "CustodyProvider",
    example: CustodyProvider.MAGICBLOCK,
  })
  @IsEnum(CustodyProvider)
  provider!: CustodyProvider;

  @ApiProperty({
    example: "So11111111111111111111111111111111111111112",
    description: "Solana mint address to read private balance for",
  })
  @IsSolanaAddress()
  mint!: string;
}
