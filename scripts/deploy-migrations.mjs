import { spawn } from 'node:child_process';

const maxAttempts = 5;
const retryDelayMs = 5_000;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const exitCode = await runMigration();

  if (exitCode === 0) {
    process.exit(0);
  }

  if (attempt === maxAttempts) {
    console.error(`Migration failed after ${maxAttempts} attempts.`);
    process.exit(exitCode);
  }

  console.warn(
    `Migration attempt ${attempt} failed; retrying in ${
      retryDelayMs / 1_000
    } seconds.`,
  );
  await delay(retryDelayMs);
}

function runMigration() {
  return new Promise((resolve) => {
    const child = spawn('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'inherit',
    });

    child.once('error', (error) => {
      console.error('Unable to start Prisma migration:', error);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
