import { ApiProperty } from "@nestjs/swagger";
import { IsEnum } from "class-validator";

import { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import { IsAtomicAmountString } from "../../common/validators/is-atomic-amount-string.decorator.js";
import { IsSolanaAddress } from "../../common/validators/is-solana-address.decorator.js";

export class WithdrawDto {
  @ApiProperty({
    enum: CustodyProvider,
    enumName: "CustodyProvider",
    example: CustodyProvider.MAGICBLOCK,
  })
  @IsEnum(CustodyProvider)
  provider!: CustodyProvider;

  @ApiProperty({
    example: "So11111111111111111111111111111111111111112",
    description: "Solana mint address for the token to withdraw",
  })
  @IsSolanaAddress()
  mint!: string;

  @ApiProperty({
    example: "1000000",
    description: "Atomic-unit amount as a string",
  })
  @IsAtomicAmountString()
  amount!: string;
}
