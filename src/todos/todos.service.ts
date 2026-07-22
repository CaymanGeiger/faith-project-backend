import { Injectable, NotFoundException } from '@nestjs/common';
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

    const todo = await this.prisma.todoItem.update({
      where: { id },
      data: {
        status: dto.completed ? TodoItemStatus.COMPLETED : TodoItemStatus.OPEN,
        completedAt: dto.completed ? new Date() : null,
      },
    });

    if (todo.type === 'JB_WARRANTIES' && dto.completed) {
      await this.prisma.prospectProfile.update({
        where: { userId: prospectUserId },
        data: { jbWarrantiesCompletedAt: todo.completedAt },
      });
    }

    return { todo };
  }
}
