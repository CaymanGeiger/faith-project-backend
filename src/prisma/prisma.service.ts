import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    super(
      databaseUrl
        ? {
            datasourceUrl: withProductionConnectionSettings(databaseUrl),
          }
        : {},
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async onModuleInit() {
    await this.$connect();
  }
}

function withProductionConnectionSettings(databaseUrl: string) {
  const url = new URL(databaseUrl);

  if (!url.searchParams.has('connect_timeout')) {
    url.searchParams.set('connect_timeout', '15');
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', '15');
  }
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', '10');
  }

  return url.toString();
}
