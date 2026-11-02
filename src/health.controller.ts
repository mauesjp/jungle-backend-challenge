import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

@Controller('health')
export class HealthController {
  constructor(private readonly em: EntityManager) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // Verifica a conexão com PostgreSQL.
  // SQS será incluído quando integrarmos a fila.
  @Get('ready')
  async ready() {
    try {
      await this.em.getConnection().execute('select 1');

      return {
        status: 'ok',
        postgres: 'ok',
        sqs: 'not_configured',
      };
    } catch {
      throw new ServiceUnavailableException('PostgreSQL unavailable');
    }
  }
}
