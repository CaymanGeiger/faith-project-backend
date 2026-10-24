import { SetMetadata } from '@nestjs/common';

export const BEFORE_TRAINING_KEY = 'allowBeforeInitialTraining';
export const AllowBeforeTraining = () => SetMetadata(BEFORE_TRAINING_KEY, true);

export type OnboardingIdentity = {
  role: string;
  onboardingRequired?: boolean;
  initialTrainingVerifiedAt?: Date | null;
};
const restrictedFeatures = [
  'home',
  'setup',
  'training',
  'support',
  'messaging',
  'account',
];
const dealerFeatures = [
  'benefits',
  'resources',
  'equipment',
  'marketing',
  'warranty',
  'rebates',
  'dealer-registration',
  'financing',
];

export function onboardingAccess(
  user: OnboardingIdentity,
  trainingSelected = false,
) {
  const manager = user.role === 'SALES_MANAGER';
  const verified = Boolean(user.initialTrainingVerifiedAt);
  const restricted = !manager && user.onboardingRequired === true && !verified;
  return {
    state: manager
      ? 'MANAGER'
      : verified
        ? 'TRAINING_VERIFIED'
        : restricted
          ? 'TRAINING_REQUIRED'
          : 'EXISTING_ACCESS',
    restricted,
    trainingVerifiedAt: user.initialTrainingVerifiedAt?.toISOString() ?? null,
    nextAction: restricted
      ? trainingSelected
        ? 'WAIT_FOR_VERIFICATION'
        : 'CHOOSE_TRAINING'
      : null,
    allowedFeatures: restricted
      ? [...restrictedFeatures]
      : [...restrictedFeatures, ...dealerFeatures],
  };
}
