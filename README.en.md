# @miint-sunny/dsh-plugin-sync

[简体中文](README.md)

A DeepSeek Harness (DSH) desktop plugin that syncs desktop plugins between two Macs. macOS only. It syncs:

- which plugins are installed, and their versions;
- each plugin's selection, official plugins included;
- the switches of the components inside each plugin;
- compatibility exemptions.

Install it on both Macs, export on one and import on the other.

It does not sync sessions, sign-in state, `.credentials.yaml`, plugin configuration (it may hold secrets), MCP, skills, the `dsh-tui` profile, or the App itself.

## Requirements

- Two Macs running macOS, both with this plugin installed. Windows is not supported yet.
- DeepSeek Harness desktop app: `>=0.2.1-rc.5 <0.3.0-0` (see `engines.dsh` in `package.json`; versions outside this range will not load the plugin); verified on App 0.2.2-rc.5.
- Syncing through a Git repository needs the system git and a remote repository (or local path) you can read and write.

## Installation

The package is `@miint-sunny/dsh-plugin-sync`. It has not been published to npm yet.

1. Download the `.tgz` package from [GitHub Releases](https://github.com/Miint-Sunny/dsh-plugin-sync/releases) and save it locally.
2. On DSH's Plugins page, choose Add and enter the absolute path to the `.tgz`, such as `/path/to/miint-sunny-dsh-plugin-sync-0.4.0.tgz`, then install. Replace the example with the actual path.
3. Restart the App after installation and confirm that this plugin's component rows are mounted and running on the Plugins page.

After the npm release, enter the full package name `@miint-sunny/dsh-plugin-sync` in the same field to install it.

Alternatively, fully quit the App and use its bundled CLI to install the local package:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /path/to/miint-sunny-dsh-plugin-sync-0.4.0.tgz
```

This plugin manages the `desktop` profile under the same `DSH_HOME`; another profile name cannot be substituted as a sync target. Before the first command-line installation, open DSH Desktop once so the App initializes `desktop`, then fully quit it. The CLI does not create this managed profile in place of the App. Reopen the App after installation.

## Updates and uninstalling

- Installed by npm package name: use Update on the Plugins page when a release is available, then restart the App.
- Installed from a local `.tgz`: the Plugins page cannot check npm for an update. Uninstall the current package, then install the new `.tgz` by its absolute path and restart the App.
- To uninstall, open this plugin on the Plugins page and choose Uninstall. Choose Disable if you only want to stop using it temporarily.

## Migrating from the old package

If the unscoped `dsh-plugin-sync` package is installed, uninstall it on the Plugins page before installing `@miint-sunny/dsh-plugin-sync` as described above. Do not install both names together. The package name changes; existing settings and data are kept.

## Usage

Open `dsh-plugin-sync` on the DSH plugins page. The page has three tabs: Import, Export and Settings. Plugin lists show the icon, name and description the way the DSH plugins page does. They are grouped into third-party plugins and official plugins.

### Import

1. **Source**: pick ZIP archive or Git repository.
   - ZIP archive: Choose file…, pick the .zip exported on the other Mac, and the comparison starts.
   - Git repository: the repository's machines are listed, with the most recent export chosen, and choosing one starts the comparison. The page reads the local working copy only and never goes online by itself; press Fetch for new remote commits. This Mac's row is marked This Mac and can't be chosen.
2. **Snapshot**: shows the source machine, the export time and its DSH version.
   - A snapshot from a newer DSH can't be imported until this App is upgraded.
   - If this Mac is newer, the page says the snapshot's compatibility exemptions don't apply here.
3. **Changes**: one row per plugin, with a tag for each kind of change: install, upgrade, downgrade, uninstall, enable, disable, components or compatibility exemption.
   - The changes of one plugin share one checkbox and are applied or skipped together.
   - Rows start selected, except downgrades and compatibility exemptions. The selection isn't saved; every comparison starts from the defaults.
   - Uninstall is offered only for a plugin that meets all three conditions:
     1. the last import from the same machine had it;
     2. this snapshot lacks it;
     3. the source machine didn't list it as not exported.

     A plugin installed only here is never uninstalled.
   - Dependencies that would newly be allowed to run install scripts (`allowBuilds`) are named on their plugin's row.
   - Plugins that stay as they are fold up at the end, with the reason: same as the snapshot, installed only on this Mac, or not exported by the source machine.
4. **Apply**: press Apply N changes. The confirmation says that the App quits and interrupts conversations and tasks in progress. It also lists downgrades, compatibility exemptions and newly allowed install scripts. Tick "I understand the risks and want to continue", then Quit and apply:
   1. the App quits;
   2. the profile is backed up, the files are written, and plugins are installed and verified;
   3. the App reopens.

   After the App reopens, the result shows above the tabs, with every step and the backup and log locations on request. Dismiss hides it.

### Export

1. **Destination**: ZIP archive or Git repository; the last choice is remembered.
   - ZIP archive:
     - creates a .zip with `snapshot.json` and the packages of local plugins;
     - Download saves it, and you move it to the other Mac (with AirDrop, say);
     - the link stops working when the App restarts, so export again then.
   - Git repository:
     - commits to `machines/<machine ID>/` and pushes in one step;
     - if the push fails, the commit stays in the local working copy and the page offers Retry push;
     - the plugin never creates repositories, adds remotes or force-pushes;
     - with a local path as the remote, it commits without pushing.
2. **Plugins**: this Mac's third-party and official plugins, one checkbox each. An unchecked plugin isn't exported and its row is greyed out. The selection saves immediately, and newly installed plugins are exported by default.
   - Third-party plugins export their version, source, selection, component switches and compatibility exemptions.
   - Official plugins export their selection and component switches. Always-on base bundles aren't listed.
   - The snapshot records which plugins were left out, so the importing Mac can tell "uninstalled on the source" from "not exported".

Local plugins come in two kinds:

- Local repositories installed with `link:`. The working tree must have no uncommitted changes. The plugin records the commit and packs it with the App's pnpm. A row with uncommitted changes is marked in the list ahead of the export.
- Local packages in `local-plugins/`: carried as they are.

A secret scan runs before every export:

1. It collects secret-looking values from this Mac's profile patch.
2. It scans every file of the snapshot, unpacking tgz files first.
3. It checks for common token and private-key formats.

A hit stops the export and reports only the file and the count, never the value. The scan is an extra safeguard, not a replacement for review.

### Settings

Changes take effect when you press Save.

- **Name**: shown in snapshots and in the Git repository's machine list. When empty, the macOS computer name is used.
- **Machine ID**: the directory in a Git repository. It comes from the host name and doesn't change when you rename this Mac.
- **Remote URL**: an https or ssh address (including `git@host:path`) or an absolute local path. Git uses the system credentials; the plugin never reads or stores tokens.
  - An address can't contain a password, and an https address can't contain a user name.
  - `http:` and `git:` aren't accepted.
  - Test connection checks the address with `git ls-remote`.
- **Data locations**: the data and backup directories, and how many exports are kept (the latest 5).

## Safety

- **Route access**: every route requires a loopback address and a loopback Host, and a same-origin Origin when one is sent. Every route also requires the official `connection.requestRejection(req)` sign-in check; without the official connection, every request is refused. Request bodies have a size limit.
- **Plugins not exported**: a snapshot carries none of their packages, bundles, component switches, compatibility exemptions, patches or lockfile entries.
- **Component ownership**: a component switch belongs to the plugin whose bundle declares the component in the official `pluginManager.listBundles()`. Switches nobody declares are never exported and never written by an import.
- **Writing component switches**:
  - A switch with an entry in the profile patch changes only its `disabled`, and every other byte stays.
  - A switch without one (a component that comes with a plugin and was never switched here) is appended at the end of the file as `{id, disabled}`, the way the official switch writes it.
  - The edited text must parse to exactly the expected changes before it is written.
- **Unselected plugins stay as they are**:
  - An import merges patches, `allowBuilds` and `overrides` only for the dependency trees of the selected plugins.
  - The apply plan names the plugins it leaves alone. Before the App quits, the applier checks two things:
    - their dependencies and bundles stay as they are;
    - none of the plan's component switches, compatibility exemptions or snapshot patches belongs to them.
- **Patches**: plugins the import leaves alone keep this Mac's patches; installed or changed plugins take the snapshot's patches.
- **Applying**:
  - The apply lock lets only one import run at a time.
  - The profile files are backed up first, and the old `node_modules` is renamed into the backup.
  - A failure restores everything directly, without reinstalling from the network.
  - Once the applied snapshot is recorded, a failing cleanup step only adds a warning and never rolls back.
  - Backups go to `~/.dsh/backups/plugin-sync/`.
  - Leftovers move to `~/.Trash/dsh-plugin-sync-<date>/`.
- **Compatibility exemptions**: offered only when the snapshot and this Mac run the exact same DSH version, and choosing one requires a risk confirmation.

## Known limitations

- An import quits and reopens the App, which interrupts conversations and tasks in progress.
- A snapshot from a newer DSH than this Mac's can't be imported until this App is upgraded.
- Compatibility exemptions are offered only when the snapshot and this Mac run the exact same DSH version.
- What isn't synced is listed at the top; a plugin installed only on this Mac is never uninstalled by an import.

## Getting help

Report problems through [GitHub Issues](https://github.com/Miint-Sunny/dsh-plugin-sync/issues). During private testing, you can also contact the person who provided the plugin.

Include the DSH App version, plugin name and version, macOS version and chip, steps to reproduce, actual and expected results, and any component rows that failed to mount or run on the Plugins page with the exact error text. Screenshots are welcome. Remove API keys, tokens, complete configuration files, and private conversations first.

## Development

After cloning with git, run `pnpm install` and then `pnpm test`; the tests use the locally installed DSH App (set `DSH_APP` to the `.app` path if it is installed elsewhere). The export check, `pnpm run public:check`, reads only files tracked by git, so it cannot run in the source archive that GitHub attaches to a release.

## License

This plugin is released under the [MIT license](LICENSE).
