// Exercise the actual team creation/join code with Firebase-style validation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
let account = null;
let written;
function validate(value) {
  assert.notEqual(value, undefined, 'Firebase rejects undefined values');
  if (value && typeof value === 'object') Object.values(value).forEach(validate);
}
const context = vm.createContext({
  DEFAULT_AVATAR_GRADIENT: 'sunset', DAILY_STEP_GOAL: 8000, currentUser: null,
  slugifyName: () => 'team', randomCode: () => 'ABCDEF',
  uniqueLoginForTeam: async () => 'new-user',
  db: { ref: (path) => ({
    once: async () => ({ val: () => path.startsWith('inviteCodes/') ? 'existing-team' : account }),
    update: async (updates) => { validate(updates); written = updates; }
  }) }
});
vm.runInContext(source.slice(source.indexOf('function seedTeamProfile('), source.indexOf('// If this Firebase Auth email')), context);
(async () => {
  for (const action of [
    () => context.createTeam('uid', 'Trip', '2026-12-01', 'Alice'),
    () => context.joinTeamByCode('uid', 'ABCDEF', 'Alice')
  ]) {
    for (account of [null, {}, { avatar: '', avatarGradient: null, dailyGoal: undefined }]) {
      const result = await action();
      const profile = written[`teams/${result.teamId}/profiles/new-user`];
      assert.equal(profile.avatar, 'face1');
      assert.equal(profile.dailyGoal, 8000);
      assert.equal(written['users/uid/profile/name'], 'Alice');
      assert.ok(written[`users/uid/memberships/${result.teamId}`]);
    }
    account = { name: 'Saved', avatar: 'face4', dailyGoal: 10000 };
    await action();
    assert.equal(written['users/uid/profile/avatar'], undefined);
    assert.equal(written['users/uid/profile/avatarGradient'], 'sunset');
  }
  context.currentUser = { name: 'Old team', avatar: 'face3', avatarGradient: 'mint', dailyGoal: 9000 };
  account = { avatar: null };
  const result = await context.createTeam('uid', 'Trip', '2026-12-01', 'Alice');
  assert.equal(written[`teams/${result.teamId}/profiles/new-user`].avatar, 'face3');
  assert.equal(written['users/uid/profile/dailyGoal'], 9000);
  console.log('PASS: create/join with missing and partial profiles, preserved preferences and previous-team fallback');
})().catch((error) => { console.error(error); process.exitCode = 1; });
