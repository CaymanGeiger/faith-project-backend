import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TodoItemType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TodosService } from './todos.service';

function fixture(type: TodoItemType | null) {
  const existing = type ? { id: 'task', prospectUserId: 'dealer', type } : null;
  const update = jest
    .fn()
    .mockImplementation(({ data }) =>
      Promise.resolve({ ...existing, ...data }),
    );
  const profileUpdate = jest.fn().mockResolvedValue({});
  const transaction = jest.fn((operation: (tx: unknown) => unknown) =>
    operation({
      todoItem: { update },
      prospectProfile: { update: profileUpdate },
    }),
  );
  const findFirst = jest.fn().mockResolvedValue(existing);
  const prisma = {
    todoItem: { findFirst },
    $transaction: transaction,
  } as unknown as PrismaService;
  return {
    service: new TodosService(prisma),
    findFirst,
    update,
    profileUpdate,
    transaction,
  };
}

describe('TodosService manual updates', () => {
  it.each([
    TodoItemType.CLASS_SIGNUP,
    TodoItemType.EQUIPMENT_REGISTRATION,
    TodoItemType.MARKETING_CONSULTATION,
  ])('does not let a dealer override derived %s progress', async (type) => {
    const f = fixture(type);
    for (const completed of [true, false]) {
      await expect(
        f.service.update('dealer', 'task', { completed }),
      ).rejects.toThrow(BadRequestException);
    }
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it('checks task ownership before exposing whether its type is editable', async () => {
    const f = fixture(null);
    await expect(
      f.service.update('dealer', 'other-task', { completed: true }),
    ).rejects.toThrow(NotFoundException);
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { id: 'other-task', prospectUserId: 'dealer' },
    });
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('keeps warranty self-confirmation and the profile timestamp consistent', async () => {
    const f = fixture(TodoItemType.JB_WARRANTIES);
    const { todo } = await f.service.update('dealer', 'task', {
      completed: true,
    });
    expect(todo.status).toBe('COMPLETED');
    expect(todo.completedAt).toBeInstanceOf(Date);
    expect(f.profileUpdate).toHaveBeenCalledWith({
      where: { userId: 'dealer' },
      data: { jbWarrantiesCompletedAt: todo.completedAt },
    });
    await f.service.update('dealer', 'task', { completed: false });
    expect(f.profileUpdate).toHaveBeenLastCalledWith({
      where: { userId: 'dealer' },
      data: { jbWarrantiesCompletedAt: null },
    });
  });

  it('permits resource-review confirmation without changing warranty status', async () => {
    const f = fixture(TodoItemType.RESOURCE_REVIEW);
    const { todo } = await f.service.update('dealer', 'task', {
      completed: true,
    });
    expect(todo.status).toBe('COMPLETED');
    expect(f.profileUpdate).not.toHaveBeenCalled();
  });
});
