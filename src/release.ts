import GHub from '@octokit/rest';
import * as fs from 'fs';
import { inc, ReleaseType } from 'semver';
import { promisify } from 'util';

import { SyncHook } from 'tapable';
import { Memoize } from 'typescript-memoize';
import Changelog from './changelog';
import { ICreateLabelsCommandOptions } from './cli/args';
import Git from './git';
import LogParse, { IExtendedCommit } from './log-parse';
import SEMVER, { calculateSemVerBump } from './semver';
import execPromise from './utils/exec-promise';
import { dummyLog, ILogger } from './utils/logger';
import { makeReleaseHooks } from './utils/make-hooks';
import postToSlack from './utils/slack';

export type VersionLabel =
  | SEMVER.major
  | SEMVER.minor
  | SEMVER.patch
  | 'skip-release'
  | 'release'
  | 'prerelease';

export const defaultLabels: VersionLabel[] = [
  SEMVER.major,
  SEMVER.minor,
  SEMVER.patch,
  'skip-release',
  'release',
  'prerelease'
];

export const isVersionLabel = (label: string): label is VersionLabel =>
  defaultLabels.includes(label as VersionLabel);

export interface IReleaseOptions {
  jira?: string;
  slack?: string;
  githubApi?: string;
  name?: string;
  email?: string;
  owner?: string;
  repo?: string;
  skipReleaseLabels: string[];
  onlyPublishWithReleaseLabel?: boolean;
  noVersionPrefix?: boolean;
  plugins?: (string | [string, any])[];
  labels: ILabelDefinitionMap;
}

export interface ILabelDefinition {
  name: string;
  title?: string;
  color?: string;
  description: string;
}

export interface ILabelDefinitionMap {
  [label: string]: ILabelDefinition;
}

export const defaultLabelDefinition: ILabelDefinitionMap = {
  [SEMVER.major]: {
    name: 'major',
    title: '💥  Breaking Change',
    description: 'Increment the major version when merged'
  },
  [SEMVER.minor]: {
    name: 'minor',
    title: '🚀  Enhancement',
    description: 'Increment the minor version when merged'
  },
  [SEMVER.patch]: {
    name: 'patch',
    title: '🐛  Bug Fix',
    description: 'Increment the patch version when merged'
  },
  'skip-release': {
    name: 'skip-release',
    description: 'Preserve the current version when merged'
  },
  release: {
    name: 'release',
    description: 'Create a release when this pr is merged'
  },
  prerelease: {
    name: 'prerelease',
    title: '🚧 Prerelease',
    description: 'Create a pre-release version when merged'
  },
  internal: {
    name: 'internal',
    title: '🏠  Internal',
    description: 'Changes only affect the internal API'
  },
  documentation: {
    name: 'documentation',
    title: '📝  Documentation',
    description: 'Changes only affect the documentation'
  }
};

export const getVersionMap = (labels = defaultLabelDefinition) =>
  Object.entries(labels).reduce((semVer, [label, labelDef]) => {
    if (isVersionLabel(label)) {
      semVer.set(label, labelDef.name);
    }

    return semVer;
    // tslint:disable-next-line align
  }, new Map<VersionLabel, string>());

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

export interface IReleaseHooks {
  onCreateChangelog: SyncHook<[Changelog]>;
  onCreateLogParse: SyncHook<[LogParse]>;
}

/**
 * A class for interacting with the git remote
 */
export default class Release {
  readonly options: IReleaseOptions;
  readonly hooks: IReleaseHooks;

  private readonly git: Git;
  private readonly logger: ILogger;
  private readonly versionLabels: Map<VersionLabel, string>;

  constructor(
    git: Git,
    options: IReleaseOptions = {
      skipReleaseLabels: [],
      labels: defaultLabelDefinition
    },
    logger: ILogger = dummyLog()
  ) {
    this.options = options;
    this.logger = logger;
    this.hooks = makeReleaseHooks();
    this.versionLabels = getVersionMap(options.labels);
    this.git = git;
  }

  /**
   * Generate a changelog from a range of commits.
   *
   * @param from sha or tag to start changelog from
   * @param to sha or tag to end changelog at (defaults to HEAD)
   */
  async generateReleaseNotes(from: string, to = 'HEAD'): Promise<string> {
    const commits = await this.getCommitsInRelease(from, to);
    const project = await this.git.getProject();
    const changelog = new Changelog(this.logger, {
      owner: this.git.options.owner,
      repo: this.git.options.repo,
      baseUrl: project.html_url,
      jira: this.options.jira,
      labels: this.options.labels
    });

    this.hooks.onCreateChangelog.call(changelog);
    changelog.loadDefaultHooks();

    return changelog.generateReleaseNotes(commits);
  }

  async getCommitsInRelease(from: string, to = 'HEAD') {
    const allCommits = await this.getCommits(from, to);
    const allPrCommits = await Promise.all(
      allCommits
        .filter(commit => commit.pullRequest)
        .map(async commit =>
          this.git.getCommitsForPR(Number(commit.pullRequest!.number))
        )
    );
    const allPrCommitHashes = allPrCommits
      .filter(Boolean)
      .reduce(
        (all, pr) => [...all, ...pr.map(subCommit => subCommit.sha)],
        [] as string[]
      );

    const labelled = allCommits.filter(
      commit =>
        !allPrCommitHashes.includes(commit.hash) &&
        !commit.subject.includes('[skip ci]')
    );

    await Promise.all(
      labelled.map(async commit => {
        if (commit.pullRequest) {
          return commit;
        }

        const prs = await this.git.searchRepo({ q: commit.hash });

        if (prs && prs.items && prs.total_count > 0) {
          const labels: ILabelDefinition[] = prs.items[0].labels || [];

          commit.labels = [
            ...labels.map(label => label.name),
            ...commit.labels
          ];
        } else {
          commit.labels = ['pushToMaster', ...commit.labels];
        }

        commit.subject = commit.subject.split('\n')[0];
      })
    );

    return labelled;
  }

  /**
   * Prepend a set of release notes to the changelog.md
   *
   * @param releaseNotes Release notes to prepend to the changelog
   * @param lastRelease Last release version of the code. Could be the first commit SHA
   * @param currentVersion Current version of the code
   * @param message Message to commit the changelog with
   */
  async addToChangelog(
    releaseNotes: string,
    lastRelease: string,
    currentVersion: string,
    message = 'Update CHANGELOG.md [skip ci]'
  ) {
    this.logger.verbose.info('Adding new changes to changelog.');

    let version;

    if (lastRelease.match(/\d+\.\d+\.\d+/)) {
      version = await this.calcNextVersion(lastRelease);
    } else {
      // lastRelease is a git sha. no releases have been made
      const bump = await this.getSemverBump(lastRelease);
      version = inc(currentVersion, bump as ReleaseType);
    }

    this.logger.verbose.info('Calculated next version to be:', version);

    const date = new Date().toDateString();
    const prefixed =
      this.options.noVersionPrefix || (version && version.startsWith('v'))
        ? version
        : `v${version}`;

    let newChangelog = `# ${prefixed} (${date})\n\n${releaseNotes}`;

    if (fs.existsSync('CHANGELOG.md')) {
      this.logger.verbose.info('Old changelog exists, prepending changes.');
      const oldChangelog = await readFile('CHANGELOG.md', 'utf8');
      newChangelog = `${newChangelog}\n\n---\n\n${oldChangelog}`;
    }

    await writeFile('CHANGELOG.md', newChangelog);
    this.logger.verbose.info('Wrote new changelog to filesystem.');

    await execPromise('git', ['add', 'CHANGELOG.md']);
    await execPromise('git', ['commit', '-m', `"${message}"`, '--no-verify']);
    this.logger.verbose.info('Commited new changelog.');
  }

  /**
   * Get a range of commits. The commits will have PR numbers and labels attached
   *
   * @param from Tag or SHA to start at
   * @param to Tage or SHA to end at (defaults to HEAD)
   */
  async getCommits(from: string, to = 'HEAD'): Promise<IExtendedCommit[]> {
    this.logger.verbose.info(`Getting commits from ${from} to ${to}`);

    const gitlog = await this.git.getGitLog(from, to);

    this.logger.veryVerbose.info('Got gitlog:\n', gitlog);

    const logParse = await this.createLogParse();
    const commits = await logParse.normalizeCommits(gitlog);

    this.logger.veryVerbose.info('Added labels to commits:\n', commits);

    await Promise.all(
      commits.map(async commit => {
        let resolvedAuthors = [];

        if (commit.pullRequest) {
          const prCommits = await this.git.getCommitsForPR(
            Number(commit.pullRequest.number)
          );

          if (!prCommits) {
            return;
          }

          resolvedAuthors = await Promise.all(
            prCommits.map(async prCommit => {
              if (prCommit && prCommit.author) {
                return this.git.getUserByUsername(prCommit.author.login);
              }
            })
          );
        } else if (commit.authorEmail) {
          const author = await this.git.getUserByEmail(commit.authorEmail);
          resolvedAuthors.push(author);
        }

        commit.authors = resolvedAuthors.map(author => ({
          ...author,
          username: author ? author.login : undefined
        }));

        commit.authors.map(author => {
          this.logger.veryVerbose.info(`Found author: ${author.username}`);
        });
      })
    );

    return commits;
  }

  async addLabelsToProject(
    labels: Partial<ILabelDefinitionMap>,
    options: ICreateLabelsCommandOptions = {}
  ) {
    const oldLabels = await this.git.getProjectLabels();
    const labelsToCreate = Object.entries(labels).filter(
      ([versionLabel, labelDef]) => {
        if (!labelDef) {
          return;
        }

        if (
          versionLabel === 'release' &&
          !this.options.onlyPublishWithReleaseLabel
        ) {
          return;
        }

        if (
          versionLabel === 'skip-release' &&
          this.options.onlyPublishWithReleaseLabel
        ) {
          return;
        }

        return true;
      }
    );

    if (!options.dryRun) {
      await Promise.all(
        labelsToCreate.map(async ([label, labelDef]) => {
          if (!labelDef) {
            return;
          }

          if (oldLabels && oldLabels.includes(labelDef.name)) {
            await this.git.updateLabel(label, labelDef);
          } else {
            await this.git.createLabel(label, labelDef);
          }
        })
      );
    }

    const repoMetadata = await this.git.getProject();
    const justLabelNames = labelsToCreate.map(([name]) => name);

    if (justLabelNames.length > 0) {
      const state = options.dryRun ? 'Would have created' : 'Created';
      this.logger.log.log(`${state} labels: ${justLabelNames.join(', ')}`);
    } else {
      const state = options.dryRun ? 'would have been' : 'were';
      this.logger.log.log(
        `No labels ${state} created, they must have already been present on your project.`
      );
    }

    if (options.dryRun) {
      return;
    }

    this.logger.log.log(
      `\nYou can see these, and more at ${repoMetadata.html_url}/labels`
    );
  }

  /**
   * Calculate the SEMVER bump over a range of commits using the PR labels
   *
   * @param from Tag or SHA to start at
   * @param to Tage or SHA to end at (defaults to HEAD)
   */
  async getSemverBump(from: string, to = 'HEAD'): Promise<SEMVER> {
    const commits = await this.getCommits(from, to);
    const labels = commits.map(commit => commit.labels);
    const { onlyPublishWithReleaseLabel, skipReleaseLabels } = this.options;
    const options = { onlyPublishWithReleaseLabel, skipReleaseLabels };

    this.logger.verbose.info('Calculating SEMVER bump using:\n', {
      labels,
      versionLabels: this.versionLabels,
      options
    });

    const result = calculateSemVerBump(labels, this.versionLabels, options);

    this.logger.verbose.success('Calculated SEMVER bump:', result);

    return result;
  }

  /**
   * Post the release notes to slack.
   *
   * @param releaseNotes Release notes to post to slack
   * @param tag Version to include in the title of the slack message
   */
  async postToSlack(releaseNotes: string, tag: string) {
    if (!this.options.slack) {
      throw new Error('Slack url must be set to post a message to slack.');
    }

    const project = await this.git.getProject();

    this.logger.verbose.info('Posting release notes to slack.');

    await postToSlack(releaseNotes, {
      tag,
      owner: this.git.options.owner,
      repo: this.git.options.repo,
      baseUrl: project.html_url,
      slackUrl: this.options.slack
    });

    this.logger.verbose.info('Posted release notes to slack.');
  }

  async calcNextVersion(lastTag: string) {
    const bump = await this.getSemverBump(lastTag);
    return inc(lastTag, bump as ReleaseType);
  }

  @Memoize()
  private async createLogParse() {
    const logParse = new LogParse();

    logParse.hooks.parseCommit.tapPromise('Labels', async commit =>
      this.addLabelsToCommit(commit)
    );
    logParse.hooks.parseCommit.tapPromise('PR Commits', async commit => {
      const prsSinceLastRelease = await this.getPRsSinceLastRelease();
      return this.getPRForRebasedCommits(commit, prsSinceLastRelease);
    });

    this.hooks.onCreateLogParse.call(logParse);

    return logParse;
  }

  @Memoize()
  private async getPRsSinceLastRelease() {
    let lastRelease: { published_at: string };

    try {
      lastRelease = await this.git.getLatestReleaseInfo();
    } catch (error) {
      const firstCommit = await this.git.getFirstCommit();

      lastRelease = {
        published_at: await this.git.getCommitDate(firstCommit)
      };
    }

    if (!lastRelease) {
      return [];
    }

    const prsSinceLastRelease = await this.git.searchRepo({
      q: `is:pr is:merged merged:>=${lastRelease.published_at}`
    });

    if (!prsSinceLastRelease || !prsSinceLastRelease.items) {
      return [];
    }

    const data = await Promise.all(prsSinceLastRelease.items.map(
      async (pr: { number: number }) =>
        this.git.getPullRequest(Number(pr.number))
    ) as GHub.Response<GHub.PullsGetResponse>[]);

    return data.map(item => item.data);
  }

  /**
   * Add the PR labels to the commit
   *
   * @param commits Commits to modify
   */
  private async addLabelsToCommit(commit: IExtendedCommit) {
    if (!commit.labels) {
      commit.labels = [];
    }

    if (commit.pullRequest) {
      const labels =
        (await this.git.getLabels(commit.pullRequest.number)) || [];
      commit.labels = [...labels, ...commit.labels];
    }

    return commit;
  }

  /**
   * Commits from rebased PRs do not have messages that tie them to a PR
   * Instead we have to find all PRs since the last release and try to match
   * their merge commit SHAs.
   *
   * @param commits Commits to modify
   */
  private getPRForRebasedCommits(
    commit: IExtendedCommit,
    pullRequests: GHub.PullsGetResponse[]
  ) {
    const matchPr = pullRequests.find(
      pr => pr.merge_commit_sha === commit.hash
    );

    if (!commit.pullRequest && matchPr) {
      const labels = matchPr.labels.map(label => label.name) || [];
      commit.labels = [...labels, ...commit.labels];
      commit.pullRequest = {
        number: matchPr.number
      };
    }

    return commit;
  }
}
