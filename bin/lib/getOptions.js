import { readFileSync } from 'jsonfile';
import path from 'path';
import { parse } from 'url';
import {
  CHROMATIC_CREATE_TUNNEL,
  CHROMATIC_PROJECT_TOKEN,
  CHROMATIC_INDEX_URL,
  CHROMATIC_TUNNEL_URL,
} from '../constants';
import getStorybookConfiguration from './getStorybookConfiguration';

import inferredOptions from '../ui/messages/info/inferredOptions';
import duplicatePatchBuild from '../ui/messages/errors/duplicatePatchBuild';
import invalidExitOnceUploaded from '../ui/messages/errors/invalidExitOnceUploaded';
import invalidPatchBuild from '../ui/messages/errors/invalidPatchBuild';
import invalidSingularOptions from '../ui/messages/errors/invalidSingularOptions';
import missingBuildScriptName from '../ui/messages/errors/missingBuildScriptName';
import missingProjectToken from '../ui/messages/errors/missingProjectToken';
import missingScriptName from '../ui/messages/errors/missingScriptName';
import missingStorybookPort from '../ui/messages/errors/missingStorybookPort';
import unknownStorybookPort from '../ui/messages/errors/unknownStorybookPort';

const takeLast = input => (Array.isArray(input) ? input[input.length - 1] : input);

const resolveHomeDir = filepath =>
  filepath && filepath.startsWith('~') ? path.join(process.env.HOME, filepath.slice(1)) : filepath;

export default async function getOptions({ flags, argv, log }) {
  const [patchHeadRef, patchBaseRef] = (flags.patchBuild || '').split('...').filter(Boolean);

  const options = {
    projectToken: takeLast(flags.projectToken || flags.appCode) || CHROMATIC_PROJECT_TOKEN, // backwards compatibility
    config: flags.config,

    only: flags.only,
    list: flags.list,
    fromCI: !!flags.ci,
    skip: flags.skip === '' ? true : flags.skip,
    verbose: !!flags.debug,
    interactive: !flags.ci && !!flags.interactive,

    autoAcceptChanges: flags.autoAcceptChanges === '' ? true : flags.autoAcceptChanges,
    exitZeroOnChanges: flags.exitZeroOnChanges === '' ? true : flags.exitZeroOnChanges,
    exitOnceUploaded: flags.exitOnceUploaded === '' ? true : flags.exitOnceUploaded,
    ignoreLastBuildOnBranch: flags.ignoreLastBuildOnBranch,
    preserveMissingSpecs: flags.preserveMissing,
    originalArgv: argv,

    buildScriptName: flags.buildScriptName,
    allowConsoleErrors: flags.allowConsoleErrors,
    scriptName: flags.scriptName === '' ? true : flags.scriptName,
    exec: flags.exec,
    noStart: !!flags.doNotStart,
    https: flags.storybookHttps,
    cert: flags.storybookCert,
    key: flags.storybookKey,
    ca: flags.storybookCa,
    port: flags.storybookPort,
    storybookUrl: flags.storybookUrl === '' ? true : flags.storybookUrl,
    storybookBuildDir: flags.storybookBuildDir
      ? path.resolve(
          Array.isArray(flags.storybookBuildDir)
            ? flags.storybookBuildDir[0]
            : flags.storybookBuildDir
        )
      : undefined,
    createTunnel: !flags.storybookUrl && CHROMATIC_CREATE_TUNNEL !== 'false',
    indexUrl: CHROMATIC_INDEX_URL,
    tunnelUrl: CHROMATIC_TUNNEL_URL,

    patchHeadRef,
    patchBaseRef,
  };

  if (!options.projectToken) {
    throw new Error(missingProjectToken());
  }

  if (flags.patchBuild) {
    if (!options.patchHeadRef || !options.patchBaseRef) {
      throw new Error(invalidPatchBuild());
    }
    if (options.patchHeadRef === options.patchBaseRef) {
      throw new Error(duplicatePatchBuild());
    }
  }

  const packageJson = readFileSync(path.resolve('./package.json'));
  const { storybookBuildDir, exec } = options;
  let { port, storybookUrl, noStart, scriptName, buildScriptName } = options;
  let https = options.https && {
    cert: options.cert,
    key: options.key,
    ca: options.ca,
  };

  // We can only have one of these arguments
  const singularOpts = {
    buildScriptName: '--build-script-name',
    scriptName: '--script-name',
    exec: '--exec',
    storybookUrl: '--storybook-url',
    storybookBuildDir: '--storybook-build-dir',
  };
  const foundSingularOpts = Object.keys(singularOpts).filter(name => !!options[name]);

  if (foundSingularOpts.length > 1) {
    throw new Error(invalidSingularOptions(foundSingularOpts.map(key => singularOpts[key])));
  }

  // No need to start or build Storybook if we're going to fetch from a URL
  if (storybookUrl) {
    noStart = true;
  }

  if (noStart && options.exitOnceUploaded) {
    throw new Error(invalidExitOnceUploaded());
  }

  if (scriptName && options.exitOnceUploaded) {
    throw new Error(invalidExitOnceUploaded());
  }

  // Build Storybook instead of starting it
  if (!scriptName && !exec && !noStart && !storybookUrl && !port) {
    if (storybookBuildDir) {
      return { ...options, noStart: true };
    }
    buildScriptName = typeof buildScriptName === 'string' ? buildScriptName : 'build-storybook';
    if (packageJson.scripts && packageJson.scripts[buildScriptName]) {
      return { ...options, noStart: true, buildScriptName };
    }
    throw new Error(missingBuildScriptName(buildScriptName));
  }

  // Start Storybook on localhost and generate the URL to it
  if (!storybookUrl) {
    if (exec && !port) {
      throw new Error(missingStorybookPort());
    }

    if (!exec && (!port || !noStart)) {
      // If you don't provide a port or we need to start the command, let's look up the script for it
      scriptName = typeof scriptName === 'string' ? scriptName : 'storybook';
      const storybookScript = packageJson.scripts && packageJson.scripts[scriptName];

      if (!storybookScript) {
        throw new Error(missingScriptName(scriptName));
      }

      https =
        https ||
        (getStorybookConfiguration(storybookScript, '--https') && {
          cert: resolveHomeDir(getStorybookConfiguration(storybookScript, '--ssl-cert')),
          key: resolveHomeDir(getStorybookConfiguration(storybookScript, '--ssl-key')),
          ca: resolveHomeDir(getStorybookConfiguration(storybookScript, '--ssl-ca')),
        });

      port = port || getStorybookConfiguration(storybookScript, '-p', '--port');
      if (!port) {
        throw new Error(unknownStorybookPort(scriptName));
      }

      if (log) log.info('', inferredOptions({ scriptName, port }));
    }

    storybookUrl = `${https ? 'https' : 'http'}://localhost:${port}`;
  }

  const parsedUrl = parse(storybookUrl);
  const suffix = 'iframe.html';
  if (!parsedUrl.pathname.endsWith(suffix)) {
    if (!parsedUrl.pathname.endsWith('/')) {
      parsedUrl.pathname += '/';
    }
    parsedUrl.pathname += suffix;
  }

  return {
    ...options,
    noStart,
    https,
    url: parsedUrl.format(),
    scriptName,
  };
}
