import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createTransport } from 'nodemailer';

@Injectable()
export class SecurityMailService {
  assertConfigured() {
    if (
      !process.env.SMTP_HOST ||
      !process.env.SMTP_USER ||
      !process.env.SMTP_PASSWORD ||
      !process.env.SECURITY_EMAIL_FROM
    ) {
      throw new ServiceUnavailableException(
        'Email verification is temporarily unavailable. Please contact Hercules support.',
      );
    }
  }

  async sendCode(email: string, code: string, purpose: string) {
    this.assertConfigured();
    const transporter = createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_PORT === '465',
      requireTLS: true,
      auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASSWORD! },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    const action =
      purpose === 'ACCOUNT_ACTIVATION'
        ? 'activate your registered dealer account'
        : purpose === 'PASSWORD_RESET'
          ? 'reset your password'
          : 'confirm your new email address';
    await transporter.sendMail({
      from: process.env.SECURITY_EMAIL_FROM,
      to: email,
      subject: 'Your Hercules Honors Rewards verification code',
      text: `Use ${code} in Hercules Honors Rewards to ${action}. This code expires in 15 minutes. Never share it with anyone. If you did not request this, ignore this email. Your account has not changed.`,
    });
  }
}
