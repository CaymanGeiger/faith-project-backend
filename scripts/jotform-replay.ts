import { createJotformRuntime, safeJotformCliError } from './jotform-runtime';

function readSubmissionId() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--submission-id');
  const value =
    index >= 0
      ? args[index + 1]
      : args
          .find((argument) => argument.startsWith('--submission-id='))
          ?.slice('--submission-id='.length);
  if (!value || !/^\d{1,64}$/.test(value)) {
    throw new Error('INVALID_JOTFORM_SUBMISSION_ID');
  }
  return value;
}

async function main() {
  const submissionId = readSubmissionId();
  const runtime = await createJotformRuntime({ backgroundProcessing: false });
  try {
    if (!runtime.config.enabled) {
      throw new Error('JOTFORM_INTEGRATION_DISABLED');
    }
    console.log(JSON.stringify(await runtime.sync.replay(submissionId)));
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
