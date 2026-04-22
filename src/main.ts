import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as dotenv from "dotenv";

import { AppModule } from "./app.module.js";

dotenv.config();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Veil Wallet Service")
    .setDescription("Custody and scheduled Solana swap API")
    .setVersion("1.0.0")
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("api", app, swaggerDocument, {
    jsonDocumentUrl: "api/json",
  });

  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
}

void bootstrap();
