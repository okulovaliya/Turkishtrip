const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
let owner = null, written, reject = false;
const account = { profile: { dailyGoal: 9000 }, memberships: { trip: { login: 'bez-imeni' } } };
const context = vm.createContext({
  AVATAR_ICON_KEYS: Array.from({ length: 12 }, (_, i) => `face${i + 1}`),
  DEFAULT_AVATAR_GRADIENT: 'sunset', DAILY_STEP_GOAL: 8000,
  db: { ref: path => ({
    once: async () => ({ val: () => path.startsWith('nicknames/') ? owner : account }),
    update: async updates => {
      if (reject) { owner = 'other'; throw new Error('PERMISSION_DENIED'); }
      written = updates;
    }
  }) }
});
vm.runInContext(source.slice(source.indexOf('function seedTeamProfile('), source.indexOf('// Whatever profile')), context);
vm.runInContext(source.slice(source.indexOf('let authSubmitting ='), source.indexOf('// Runs right after a successful Firebase sign-in:')), context);
(async () => {
  for (const profile of [null, {}, { name: 'Без имени' }, { name: 'Alice', nickname: 'alice', avatar: 'face1' }]) {
    assert.equal(context.isProfileComplete(profile), false);
  }
  assert.equal(context.isProfileComplete({ name: 'Alice', nickname: 'alice', avatar: 'face1', onboardingCompleted: true }), true);
  for (const nickname of ['ab', 'имя', 'with space', 'bad/path', 'bad&#x20;', 'a'.repeat(25)]) {
    assert.ok(context.profileInputErrors('Alice', nickname, 'face1').nickname);
  }
  assert.ok(context.profileInputErrors('', 'alice', 'face1').name);
  assert.ok(context.profileInputErrors('Alice', 'alice', '').avatar);
  await context.saveOnboardingProfile('uid', 'Alice', 'alice', 'face3');
  assert.equal(written['users/uid/profile'].onboardingCompleted, true);
  assert.equal(written['users/uid/profile'].dailyGoal, 9000);
  assert.equal(written['nicknames/alice'], 'uid');
  assert.equal(written['teams/trip/profiles/bez-imeni/nickname'], 'alice');
  assert.ok(!Object.keys(written).some(k => k.includes('activities')));
  owner = 'other';
  await assert.rejects(context.saveOnboardingProfile('uid', 'Alice', 'alice', 'face3'), /занят/);
  owner = null; reject = true;
  await assert.rejects(context.saveOnboardingProfile('uid', 'Alice', 'alice', 'face3'), /занят/);
  console.log('PASS: validation, profile completion, atomic payload, existing-team migration, nickname conflicts');
})().catch(error => { console.error(error); process.exitCode = 1; });
