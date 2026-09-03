import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtUserPayload } from '../common/decorators/current-user.decorator';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'dev-secret-change-me'),
    });
  }

  async validate(payload: any): Promise<JwtUserPayload> {
    return {
      sub: payload.sub,
      phone: payload.phone,
      role: payload.role,
      wecomUserId: payload.wecomUserId ?? null,
    };
  }
}
