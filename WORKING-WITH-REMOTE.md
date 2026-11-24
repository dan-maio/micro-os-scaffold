# Working with the GitHub remote

*Where `micro-os-scaffold` lives, how to sign in, clone, pull and push, and
how the GitHub repository and the local bare backup stay in step. The
commands are written out.*

---

## 1. The repositories

| Repository | GitHub | Local bare backup |
|---|---|---|
| `micro-os-scaffold` (this one): the scaffolder, its templates and guides | `dan-maio/micro-os-scaffold` | `/home/dan/Downloads/GIT/micro-os-scaffold.git` |
| `micro-os-scaffold-ctest-examples`: the example workspaces it produced | `dan-maio/micro-os-scaffold-ctest-examples` | `/home/dan/Downloads/GIT/micro-os-scaffold-ctest-examples.git` |
| `micro-os-plus-iii-smp2`: the µOS++ III SMP source the scaffolder reads (one repository) | `dan-maio/micro-os-plus-iii-smp2` | none (see its `WORKING-WITH-REMOTE.md`) |

All three are public on GitHub, branch `main`.

The working copy is `/home/dan/Work/micro-os-scaffold`.

---

## 2. The remotes

```bash
git -C /home/dan/Work/micro-os-scaffold remote -v
origin  https://github.com/dan-maio/micro-os-scaffold.git  (fetch/push)
local   /home/dan/Downloads/GIT/micro-os-scaffold.git      (fetch/push)
```

| Remote | What it is | Use |
|---|---|---|
| `origin` | the GitHub repository | the public copy, pull requests, cloning on another machine |
| `local` | the bare backup in `~/Downloads/GIT/` | fast local backup, offline restore |

`main` tracks `origin/main`, so plain `git pull` and `git push` talk to
GitHub. The backup is pushed by name (`git push local main`). Until
2026-11-24 the bare backup was the only remote and was called `origin`; it
was renamed `local` when GitHub was added, as in the µOS++ workspace.

---

## 3. Signing in

git reaches GitHub over HTTPS, with the GitHub CLI (`gh`) as credential
helper:

```bash
gh auth status          # Logged in to github.com account dan-maio
gh auth setup-git       # once per machine: git uses gh for github.com
```

`gh auth login` signs in. The token needs the `repo` scope to push. Never
put a token in a remote URL. SSH works too
(`git remote set-url origin git@github.com:dan-maio/micro-os-scaffold.git`
after adding your key to the account).

---

## 4. Clone and use

```bash
git clone https://github.com/dan-maio/micro-os-scaffold.git
cd micro-os-scaffold
node bin/scaffold.js --help
```

Node.js 18 or newer is all the scaffolder itself needs (no npm packages).
To scaffold, it needs a µOS++ source: a folder, or git URLs. The current
source is one clone of `micro-os-plus-iii-smp2`:

```bash
git clone https://github.com/dan-maio/micro-os-plus-iii-smp2.git ../micro-os-plus-iii-smp2
node bin/scaffold.js discover --source ../micro-os-plus-iii-smp2
node bin/scaffold.js /path/to/workspace \
  --source ../micro-os-plus-iii-smp2 \
  --select aarch64-rpi4b.smp_test0 --yes
```

The toolchains, CMake, Ninja, QEMU and OpenOCD come from the xPack store
(`~/.local/xPacks`); `README.md` lists the requirements.

---

## 5. Daily work

```bash
cd /home/dan/Work/micro-os-scaffold
git pull --ff-only                    # GitHub first, so you build on the latest
# ... edit, test ...
git add -A && git commit -m "..."
git push                              # GitHub
git push local main                   # the backup, last
```

Push to GitHub first and to the backup last: if GitHub refuses the push,
the backup still holds what was last published.

`--ff-only` stops instead of creating a merge commit when GitHub has
commits you do not. Then look (`git log --oneline --graph --all -20`) and
rebase (`git rebase origin/main`) or merge, test, and push again.

### 5.1 The PDFs

Every guide with a PDF is rendered from its Markdown with pandoc and
WeasyPrint. Render it again in the same commit as the Markdown:

```bash
pandoc README.md -o README.pdf --pdf-engine=weasyprint --css scaffold.css --metadata pagetitle=README
pandoc scaffold.md -o scaffold.pdf --pdf-engine=weasyprint --css scaffold.css --metadata pagetitle=scaffold
pandoc WORKING-WITH-REMOTE.md -o WORKING-WITH-REMOTE.pdf --pdf-engine=weasyprint --css scaffold.css --metadata pagetitle=WORKING-WITH-REMOTE
```

The two guides in `templates/` (`README_API_CTEST`, `README_STDC++`) are
rendered with a title block (pandoc metadata `title`/`subtitle`) and the
`STDCXX.css` stylesheet.

---

## 6. Before pushing (the repository is public)

- Never commit a workspace's build tree, a CMake cache, or a scaffolded
  test workspace: Wi-Fi test credentials live only in CMake caches
  (`-D WIFI_TEST_SSID=... -D WIFI_TEST_PASS=...`).
- See what a push carries:

  ```bash
  git log --oneline origin/main..main
  git diff --stat origin/main main
  ```

- Check that a value you must not publish is not in the new commits, without
  printing it:

  ```bash
  read -rs SECRET
  git log -p origin/main..main | grep -c -F -- "$SECRET"   # must print 0
  unset SECRET
  ```

The whole history was searched this way before the first push
(2026-11-24): no Wi-Fi value, token, key or credential file.

---

## 7. Releases and pull requests

```bash
git tag -a v0.2.0 -m "micro-os-scaffold 0.2.0"
git push origin v0.2.0 && git push local v0.2.0

git switch -c my-change
# ... commit ...
git push -u origin my-change
gh pr create --repo dan-maio/micro-os-scaffold --base main --head my-change
```

---

## 8. Restore or move to another machine

From GitHub:

```bash
git clone https://github.com/dan-maio/micro-os-scaffold.git
git -C micro-os-scaffold remote add local /home/dan/Downloads/GIT/micro-os-scaffold.git
```

From the backup, when offline:

```bash
git clone /home/dan/Downloads/GIT/micro-os-scaffold.git
cd micro-os-scaffold
git remote rename origin local
git remote add origin https://github.com/dan-maio/micro-os-scaffold.git
git fetch origin && git branch -u origin/main
```

---

## 9. Cheat sheet

| Task | Command |
|---|---|
| Sign in / check | `gh auth login`, `gh auth status`, `gh auth setup-git` |
| Clone | `git clone https://github.com/dan-maio/micro-os-scaffold.git` |
| Pull | `git pull --ff-only` |
| Push to GitHub, then the backup | `git push && git push local main` |
| Preview a push | `git push --dry-run` |
| What GitHub does not have yet | `git log --oneline origin/main..main` |
| Compare with GitHub, no fetch | `git ls-remote origin refs/heads/main` |
| Compare with the backup, no fetch | `git ls-remote local refs/heads/main` |

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Authentication failed`, `403` | not signed in, or the token lacks `repo` | `gh auth status`, `gh auth login`, `gh auth setup-git` |
| git asks for a password | the `gh` credential helper is not set | `gh auth setup-git` |
| `! [rejected] … (non-fast-forward)` | GitHub has commits you do not | `git pull --ff-only`, or rebase/merge, then push |
| `git push` goes to the backup | an old clone where `origin` is still the backup | rename the remotes (section 8) |
| a PDF is older than its Markdown | not rendered again | the commands in section 5.1 |

---

## 11. State on 2026-11-24

`main` was pushed to both `origin` (GitHub, public) and `local` (the bare
backup), at the same commit, with `main` tracking `origin/main`.
