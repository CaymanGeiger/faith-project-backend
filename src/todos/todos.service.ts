import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TodoItemStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateTodoDto } from './dto/update-todo.dto';

@Injectable()
export class TodosService {
  constructor(private readonly prisma: PrismaService) {}

  async list(prospectUserId: string) {
    const todos = await this.prisma.todoItem.findMany({
      where: { prospectUserId },
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
    });

    return { todos };
  }

  async update(prospectUserId: string, id: string, dto: UpdateTodoDto) {
    const existing = await this.prisma.todoItem.findFirst({
      where: { id, prospectUserId },
    });

    if (!existing) {
      throw new NotFoundException('To-do item not found');
    }

    if (
      existing.type !== 'JB_WARRANTIES' &&
      existing.type !== 'RESOURCE_REVIEW'
    ) {
      throw new BadRequestException(
        'This task is updated automatically when you complete its related action.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const todo = await tx.todoItem.update({
        where: { id },
        data: {
          status: dto.completed
            ? TodoItemStatus.COMPLETED
            : TodoItemStatus.OPEN,
          completedAt: dto.completed ? new Date() : null,
        },
      });

      if (todo.type === 'JB_WARRANTIES') {
        await tx.prospectProfile.update({
          where: { userId: prospectUserId },
          data: {
            jbWarrantiesCompletedAt: dto.completed ? todo.completedAt : null,
          },
        });
      }

      return { todo };
    });
  }
}
