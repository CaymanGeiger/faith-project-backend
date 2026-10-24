import { PrismaClient } from '@prisma/client';
import { preparePreviewFixtures } from './preview-fixtures';

describe('Preview fixture opt-in', () => {
  const keys = ['APP_ENV', 'DEV_FEATURES_ENABLED', 'ALLOW_PREVIEW_FIXTURES'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  it.each([
    ['production', 'true', 'true'],
    ['development', 'true', 'true'],
    [undefined, 'true', 'true'],
    ['preview', 'false', 'true'],
    ['preview', undefined, 'true'],
    ['preview', 'true', 'false'],
    ['preview', 'true', undefined],
  ])(
    'refuses APP_ENV=%s, master=%s, fixtures=%s before database access',
    async (app, master, fixtures) => {
      for (const [index, value] of [app, master, fixtures].entries()) {
        if (value === undefined) delete process.env[keys[index]];
        else process.env[keys[index]] = value;
      }
      const transaction = jest.fn();
      await expect(
        preparePreviewFixtures({
          $transaction: transaction,
        } as unknown as PrismaClient),
      ).rejects.toThrow('Preview fixtures require');
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
