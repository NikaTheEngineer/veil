import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from "class-validator";

const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9]\d*)$/;

export function IsAtomicAmountString(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: "isAtomicAmountString",
      target: target.constructor,
      propertyName: propertyName.toString(),
      options: validationOptions,
      validator: {
        validate(value: string | null | undefined): boolean {
          return typeof value === "string" && ATOMIC_AMOUNT_PATTERN.test(value);
        },
        defaultMessage(arguments_: ValidationArguments): string {
          return `${arguments_.property} must be a base-10 atomic unit string`;
        },
      },
    });
  };
}
