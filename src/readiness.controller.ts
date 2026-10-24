import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
@Controller('health')
export class ReadinessController {
  constructor(private readonly prisma: PrismaService) {}
  @Get('ready')
  async ready() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timeout')), 3000);
        }),
      ]);
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException(
        'Service is temporarily unavailable',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
