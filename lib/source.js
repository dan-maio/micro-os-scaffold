'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, ensureDir, isDirectory } = require('./util');

/*
 * The source workspace is either a local folder holding the sibling
 * repositories, or a comma separated list of git URLs that are cloned as
 * siblings into a cache folder:
 *
 *   --source /path/to/workspace
 *   --source https://host/u/micro-os-plus-iii.git,https://host/u/micro-os-plus-iii-cortexm.git --branch smp
 *   --source https://host/u/micro-os-plus-iii.git#smp,...
 *
 * A single URL may also be one repository that contains all the projects;
 * its submodules (micro-os-plus-iii-smp2 holds the ports as submodules) are
 * cloned with it.
 */

function isGitUrl(value) {
  return (
    /^(https?|git|ssh|file):\/\//.test(value) ||
    /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/.test(value)
  );
}

function isRemoteSource(value) {
  return String(value ?? '')
    .split(',')
    .some((item) => isGitUrl(item.trim()));
}

function cacheRoot() {
  const base =
    process.env.SCAFFOLD_CACHE ??
    path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'micro-os-scaffold');
  return base;
}

function repoName(url) {
  const clean = url.replace(/[#?].*$/, '').replace(/\/+$/, '');
  return path.basename(clean).replace(/\.git$/, '');
}

function git(args, options = {}) {
  return run('git', args, { timeout: 10 * 60 * 1000, ...options });
}

/** Bring the submodules of a cached clone to the commits it now pins. */
function updateSubmodules(dir) {
  if (!fs.existsSync(path.join(dir, '.gitmodules'))) return;
  const updated = git(['-C', dir, 'submodule', 'update', '--init', '--recursive', '--depth', '1']);
  if (updated.status !== 0) {
    throw new Error(`git submodule update failed in ${dir}:\n${(updated.stderr || updated.stdout).trim()}`);
  }
}

/**
 * The submodule paths of a local source folder that are not checked out
 * (a clone made without --recursive): their folders are empty, so the ports
 * would be missing.
 */
function missingSubmodules(root) {
  if (!fs.existsSync(path.join(root, '.gitmodules'))) return [];
  const listed = git(['config', '-f', path.join(root, '.gitmodules'), '--get-regexp', '^submodule\\..*\\.path$']);
  if (listed.status !== 0) return [];
  return listed.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean)
    .filter((rel) => {
      const dir = path.join(root, rel);
      return !isDirectory(dir) || fs.readdirSync(dir).length === 0;
    });
}

function cloneOrUpdate(url, branch, dir, log) {
  if (isDirectory(path.join(dir, '.git'))) {
    const fetchArgs = ['-C', dir, 'fetch', '--depth', '1', 'origin'];
    if (branch) fetchArgs.push(branch);
    const fetched = git(fetchArgs);
    if (fetched.status === 0) {
      git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD']);
      updateSubmodules(dir);
      log(`  updated ${path.basename(dir)}${branch ? ` (${branch})` : ''}`);
    } else {
      log(`  WARNING: could not update ${path.basename(dir)}; using the cached clone`);
    }
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // A source repository may hold its ports as submodules (micro-os-plus-iii-smp2):
  // fetch them too, each at the commit the repository pins, shallow.
  const args = ['clone', '--depth', '1', '--recurse-submodules', '--shallow-submodules'];
  if (branch) args.push('--branch', branch);
  args.push(url, dir);
  const cloned = git(args);
  if (cloned.status !== 0) {
    throw new Error(
      `git clone failed for ${url}${branch ? ` (branch ${branch})` : ''}:\n${(cloned.stderr || cloned.stdout).trim()}`
    );
  }
  log(`  cloned ${path.basename(dir)}${branch ? ` (${branch})` : ''}`);
}

/**
 * Resolve --source to a local workspace folder.
 * Returns { root, url } where url is the original remote specification
 * (null for a local folder), recorded in scaffold.json for regeneration.
 */
function resolveSource(value, options = {}) {
  const log = options.log ?? console.log;
  if (!isRemoteSource(value)) {
    const root = path.resolve(value);
    const missing = missingSubmodules(root);
    if (missing.length > 0) {
      throw new Error(
        `--source ${root}: submodules not checked out: ${missing.join(', ')}\n` +
          `Run: git -C ${root} submodule update --init --recursive\n` +
          '(or clone the source with git clone --recursive)'
      );
    }
    return { root, url: null, branch: null };
  }
  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of items) {
    if (!isGitUrl(item)) {
      throw new Error(`--source mixes git URLs and folders: '${item}' is not a git URL.`);
    }
  }
  const key = crypto
    .createHash('sha1')
    .update(`${items.join(',')}@${options.branch ?? ''}`)
    .digest('hex')
    .slice(0, 12);
  const root = path.join(cacheRoot(), key);
  ensureDir(root);
  log(`Cloning the source workspace into ${root}`);
  for (const item of items) {
    const [url, fragment] = item.split('#');
    cloneOrUpdate(url, fragment || options.branch || null, path.join(root, repoName(url)), log);
  }
  // One repository that holds every project is the workspace itself.
  if (items.length === 1) {
    const only = path.join(root, repoName(items[0].split('#')[0]));
    const nested = fs
      .readdirSync(only, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && /^micro-os-plus-iii($|[-.])/.test(entry.name));
    if (nested) return { root: only, url: value, branch: options.branch ?? null };
  }
  return { root, url: value, branch: options.branch ?? null };
}

module.exports = { resolveSource, isRemoteSource };
