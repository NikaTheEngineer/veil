import { PublicKey } from "@solana/web3.js";
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from "class-validator";

export function IsSolanaAddress(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: "isSolanaAddress",
      target: target.constructor,
      propertyName: propertyName.toString(),
      options: validationOptions,
      validator: {
        validate(value: string | null | undefined): boolean {
          if (typeof value !== "string" || value.trim().length === 0) {
            return false;
          }

          try {
            new PublicKey(value);
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage(arguments_: ValidationArguments): string {
          return `${arguments_.property} must be a valid Solana address`;
        },
      },
    });
  };
}
