import { createJotformRuntime, safeJotformCliError } from './jotform-runtime';

async function main() {
  const runtime = await createJotformRuntime({ backgroundProcessing: false });
  try {
    console.log(JSON.stringify(await runtime.sync.getOperationalStatus()));
  } finally {
    await runtime.prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ status: 'FAILED', code: safeJotformCliError(error) }),
  );
  process.exitCode = 1;
});
