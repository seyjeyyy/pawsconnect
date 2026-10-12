// Production deployment with the release recorded. Builds locally, then deploys the
// prebuilt output and passes the commit, branch, date and message to the deployment
// so IT Operations → Deployments shows what is live. Refuses to run with uncommitted
// changes, because the recorded commit would not describe what was deployed.
import { execFileSync, spawnSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) { console.error('Commit or stash your changes first: the release record must match a commit.'); process.exit(1); }
const release = {
  RELEASE_COMMIT: git('rev-parse', 'HEAD'),
  RELEASE_BRANCH: git('rev-parse', '--abbrev-ref', 'HEAD'),
  RELEASE_DATE: new Date().toISOString(),
  RELEASE_NOTES: git('log', '-1', '--pretty=%s').slice(0, 200),
};
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (args) => { const result = spawnSync(npx, args, { stdio: 'inherit', shell: process.platform === 'win32' }); if (result.status !== 0) process.exit(result.status ?? 1); };
run(['vercel', 'build', '--prod']);
run(['vercel', 'deploy', '--prebuilt', '--prod', ...Object.entries(release).flatMap(([key, value]) => ['-e', `${key}=${JSON.stringify(value)}`])]);
console.info(`Deployed ${release.RELEASE_COMMIT.slice(0, 7)} (${release.RELEASE_BRANCH}): ${release.RELEASE_NOTES}`);
