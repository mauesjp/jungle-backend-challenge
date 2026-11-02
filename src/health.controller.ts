import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SqsService } from './infrastructure/messaging/sqs.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    // Verifica o PostgreSQL.
    try {
      await this.em.getConnection().execute('select 1');
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        postgres: 'unavailable',
        sqs: 'unknown',
      });
    }

    // Verifica a conexão com o SQS.
    try {
      await this.sqs.checkConnection();
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        postgres: 'ok',
        sqs: 'unavailable',
      });
    }

    return {
      status: 'ok',
      postgres: 'ok',
      sqs: 'ok',
    };
  }
}
