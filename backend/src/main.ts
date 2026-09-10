import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // 服务在 nginx 反代之后：信任代理头，req.ip 才能取到真实访客 IP
  // （限流按 IP 计数、登录审计 IP 都依赖它，否则所有请求都显示成网关 IP）
  app.set('trust proxy', true);

  // 生产环境安全检查：JWT 密钥必须配置且不能用默认值，否则任何人都能伪造登录令牌
  const jwtSecret = config.get<string>('JWT_SECRET', '');
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && (!jwtSecret || jwtSecret === 'dev-secret-change-me' || jwtSecret.includes('change-me'))) {
    throw new Error(
      '[安全] 生产环境必须配置强随机 JWT_SECRET（不能用默认值/示例值），服务拒绝启动',
    );
  }

  // 全局参数校验
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // CORS：生产环境只允许中转页配置的同源域名；开发环境放开（Vite 本地联调）
  const allowedOrigin = (() => {
    const base = config.get<string>('TRANSFER_PAGE_BASE_URL', '');
    try {
      return base ? new URL(base).origin : '';
    } catch {
      return '';
    }
  })();
  app.enableCors({
    origin: (origin, cb) => {
      // 同源请求（浏览器不带 Origin）、curl/服务端请求直接放行
      if (!origin) return cb(null, true);
      if (!isProd) return cb(null, true);
      if (allowedOrigin && origin === allowedOrigin) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  });

  // 全局前缀
  app.setGlobalPrefix('api');

  const port = config.get<number>('BACKEND_PORT', 3000);
  await app.listen(port);
  console.log(`[tuike-backend] 已启动 端口: ${port}`);
}

bootstrap();
