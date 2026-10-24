import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegisterFromInviteDto } from '../auth/dto/register-from-invite.dto';
import { UpdateMeDto } from './dto/update-me.dto';

describe('Profile identity validation', () => {
  const registration = {
    token: 'synthetic-invite',
    accountType: 'PROSPECT',
    email: 'dealer@example.com',
    password: ' valid password with spaces ',
    firstName: 'Taylor',
    lastName: 'Dealer',
    companyName: 'Dealer Company',
    termsAccepted: true,
  };

  it.each(['firstName', 'lastName', 'companyName'])(
    'rejects a whitespace-only %s on registration',
    (field) => {
      const dto = plainToInstance(RegisterFromInviteDto, {
        ...registration,
        [field]: ' \t\n ',
      });
      expect(validateSync(dto).map((error) => error.property)).toContain(field);
    },
  );

  it.each(['firstName', 'lastName', 'companyName'])(
    'rejects a whitespace-only %s on profile updates',
    (field) => {
      const dto = plainToInstance(UpdateMeDto, { [field]: ' \t\n ' });
      expect(validateSync(dto).map((error) => error.property)).toContain(field);
    },
  );

  it('trims registration identities while preserving the exact password', () => {
    const dto = plainToInstance(RegisterFromInviteDto, {
      ...registration,
      firstName: ' Taylor ',
      lastName: ' Dealer ',
      companyName: ' Dealer Company ',
    });
    expect(validateSync(dto)).toEqual([]);
    expect(dto.firstName).toBe('Taylor');
    expect(dto.lastName).toBe('Dealer');
    expect(dto.companyName).toBe('Dealer Company');
    expect(dto.password).toBe(registration.password);
  });

  it('trims updated identity fields and allows an optional phone to be cleared', () => {
    const dto = plainToInstance(UpdateMeDto, {
      firstName: ' Taylor ',
      lastName: ' Dealer ',
      companyName: ' Dealer Company ',
      phone: '',
    });
    expect(validateSync(dto)).toEqual([]);
    expect(dto).toMatchObject({
      firstName: 'Taylor',
      lastName: 'Dealer',
      companyName: 'Dealer Company',
      phone: '',
    });
  });

  it('continues to allow partial profile updates and a manager registration without a company', () => {
    expect(validateSync(plainToInstance(UpdateMeDto, { phone: '' }))).toEqual(
      [],
    );
    expect(
      validateSync(
        plainToInstance(RegisterFromInviteDto, {
          ...registration,
          accountType: 'SALES_MANAGER',
          companyName: undefined,
        }),
      ),
    ).toEqual([]);
  });
});
