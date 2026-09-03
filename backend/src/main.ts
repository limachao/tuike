import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // 全局参数校验
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // CORS
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // 全局前缀
  app.setGlobalPrefix('api');

  const port = config.get<number>('BACKEND_PORT', 3000);
  await app.listen(port);
  console.log(`[tuike-backend] 已启动 端口: ${port}`);
}

bootstrap();
