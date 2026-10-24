import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { isDevelopmentSwaggerEnabled } from './config/development';
import { loadHttpRuntimeConfiguration } from './config/http-runtime';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  const { corsOrigins } = loadHttpRuntimeConfiguration();
  if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (isDevelopmentSwaggerEnabled()) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Hercules Honors Rewards Member API')
      .setDescription(
        'REST API for LG prospect onboarding and Hercules manager support.',
      )
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'openapi',
      app,
      SwaggerModule.createDocument(app, swaggerConfig),
      { raw: false },
    );
  }

  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
void bootstrap().catch(() => {
  console.error(
    'API startup failed; check release configuration and database readiness.',
  );
  process.exitCode = 1;
});
