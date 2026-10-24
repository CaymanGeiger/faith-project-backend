import {
  areDevelopmentFeaturesEnabled,
  isAccountAllowedInRuntime,
  isDevelopmentSeedEnabled,
  isDevelopmentSwaggerEnabled,
  isLocalDevelopmentDatabase,
} from './development';
import { isProductionLikeRuntime } from './runtime';

describe('Development feature configuration', () => {
  const keys = [
    'NODE_ENV',
    'APP_ENV',
    'DEV_FEATURES_ENABLED',
    'ALLOW_DEMO_SEED',
    'ENABLE_SWAGGER',
    'DATABASE_URL',
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    delete process.env.APP_ENV;
    process.env.DEV_FEATURES_ENABLED = 'true';
    process.env.ALLOW_DEMO_SEED = 'true';
    process.env.ENABLE_SWAGGER = 'true';
    process.env.DATABASE_URL = 'postgresql://localhost/faith_project';
  });
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each(['production', 'staging', '', undefined])(
    'blocks every development feature for runtime %s even with all flags set',
    (runtime) => {
      if (runtime === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = runtime;
      expect(areDevelopmentFeaturesEnabled()).toBe(false);
      expect(isDevelopmentSwaggerEnabled()).toBe(false);
      expect(isDevelopmentSeedEnabled()).toBe(false);
      expect(isAccountAllowedInRuntime('manager@hercules.local')).toBe(false);
      expect(isAccountAllowedInRuntime('real@herculesindustries.com')).toBe(
        true,
      );
    },
  );

  it.each(['false', 'TRUE', '', undefined])(
    'requires an explicit master opt-in, received %s',
    (flag) => {
      if (flag === undefined) delete process.env.DEV_FEATURES_ENABLED;
      else process.env.DEV_FEATURES_ENABLED = flag;
      expect(areDevelopmentFeaturesEnabled()).toBe(false);
      expect(isDevelopmentSwaggerEnabled()).toBe(false);
      expect(isDevelopmentSeedEnabled()).toBe(false);
      expect(isAccountAllowedInRuntime(' Manager@Demo.Hercules.Local ')).toBe(
        false,
      );
    },
  );

  it.each(['development', 'test'])(
    'allows opted-in features on runtime %s',
    (runtime) => {
      process.env.NODE_ENV = runtime;
      expect(areDevelopmentFeaturesEnabled()).toBe(true);
      expect(isDevelopmentSwaggerEnabled()).toBe(true);
      expect(isDevelopmentSeedEnabled()).toBe(true);
      expect(isAccountAllowedInRuntime('prospect@hercules.local')).toBe(true);
    },
  );

  it('allows an explicitly opted-in preview while retaining production runtime security', () => {
    process.env.APP_ENV = 'preview';
    process.env.NODE_ENV = 'production';
    expect(areDevelopmentFeaturesEnabled()).toBe(true);
    expect(isAccountAllowedInRuntime('manager@hercules.local')).toBe(true);
    expect(isProductionLikeRuntime()).toBe(true);
  });

  it('does not let a development deployment label enable hosted production-runtime tools', () => {
    process.env.APP_ENV = 'development';
    process.env.NODE_ENV = 'production';
    expect(areDevelopmentFeaturesEnabled()).toBe(false);
    process.env.NODE_ENV = 'development';
    expect(areDevelopmentFeaturesEnabled()).toBe(true);
  });

  it.each(['production', 'staging', '', 'PREVIEW', 'unknown'])(
    'blocks explicit deployment %s even when the local runtime and all feature flags permit it',
    (deployment) => {
      process.env.APP_ENV = deployment;
      expect(areDevelopmentFeaturesEnabled()).toBe(false);
      expect(isDevelopmentSwaggerEnabled()).toBe(false);
      expect(isDevelopmentSeedEnabled()).toBe(false);
      expect(isAccountAllowedInRuntime('manager@hercules.local')).toBe(false);
    },
  );

  it.each(['false', '', 'TRUE', undefined])(
    'requires the master opt-in on hosted preview, received %s',
    (flag) => {
      process.env.APP_ENV = 'preview';
      process.env.NODE_ENV = 'production';
      if (flag === undefined) delete process.env.DEV_FEATURES_ENABLED;
      else process.env.DEV_FEATURES_ENABLED = flag;
      expect(areDevelopmentFeaturesEnabled()).toBe(false);
      expect(isAccountAllowedInRuntime('manager@hercules.local')).toBe(false);
    },
  );

  it('keeps broad demo seeding disabled on a hosted preview database', () => {
    process.env.APP_ENV = 'preview';
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://preview.example.com/app';
    expect(areDevelopmentFeaturesEnabled()).toBe(true);
    expect(isDevelopmentSeedEnabled()).toBe(false);
  });

  it('preserves per-feature opt-ins', () => {
    delete process.env.ENABLE_SWAGGER;
    delete process.env.ALLOW_DEMO_SEED;
    expect(areDevelopmentFeaturesEnabled()).toBe(true);
    expect(isDevelopmentSwaggerEnabled()).toBe(false);
    expect(isDevelopmentSeedEnabled()).toBe(false);
  });

  it.each([
    'postgresql://db.example.com/faith_project',
    'postgresql://db.example.com/fixture_test',
    'postgresql://localhost/production',
    'postgresql://localhost/faith_project?host=db.example.com',
    'postgresql://localhost/fixture_test?host=db.example.com',
    'https://localhost/fixture_test',
  ])('refuses demo seeds for unsafe database %s', (database) => {
    process.env.DATABASE_URL = database;
    expect(isDevelopmentSeedEnabled()).toBe(false);
  });

  it('keeps the established local seed database without relaxing training safety', () => {
    expect(isDevelopmentSeedEnabled()).toBe(true);
    expect(isLocalDevelopmentDatabase(process.env.DATABASE_URL)).toBe(false);
  });
});
