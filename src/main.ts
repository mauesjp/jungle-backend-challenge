import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({
      json: true,
    }),
  });

  // Permite que o NestJS execute os hooks no encerramento.
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);

  await app.listen(process.env.PORT ?? 3000);
}

await bootstrap();
