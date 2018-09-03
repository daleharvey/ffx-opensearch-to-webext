#!/usr/bin/env node

const fs = require('fs');

const glob = require('glob-promise');
const program = require('commander');
const convert = require('xml-to-json-promise');
const zipFolder = require('zip-folder');
const rimraf = require('rimraf');
const rmfr = require('rmfr');
const querystring = require('querystring');

const SEARCHPLUGINS_FOLDER = 'browser/components/search/searchplugins/';
/*
 * The base manifest.json, most of this doesnt look like it will change
 * as the engine specific things are inside the
 * chrome_settings_overrides.search_provider field
 */
const MANIFEST = {
  'name': '__MSG_extensionName__',
  'description': '__MSG_extensionDescription__',
  'manifest_version': 2,
  'version': '1.0',
  'applications': {'gecko': {}},
};

/*
 * The base values for the chrome_settings_overrides.search_provider object
 */
const SEARCH_PROVIDER = {
  'name': '__MSG_extensionName__'
};

/*
 * Here we can define specific properties for individual engines, things that cant
 * be infered from the OpenSearch files, the 'manifest' and 'search_provider'
 * fields will override the above definitions
 */
const CONFIG = {

  'wikipedia': {
    'path': 'browser/components/search/searchplugins/wikipedia*',
    'manifest': {
      'applications': {
        'gecko': {'id': 'wikipedia@mozilla.org'}
      }
    },
    'search_provider': {
      'keyword': 'wp',
      'favicon_url': 'https://__MSG_url_lang__.wikipedia.org/static/favicon/wikipedia.ico',
      'search_url': 'https://__MSG_url_lang__.wikipedia.org/wiki/__MSG_url_landing__?sourceid=Mozilla-search&search={searchTerms}&lang={language}&oe={outputEncoding}&ml={moz:locale}&mdi={moz:distributionID}&mo={moz:official}',
      'suggest_url': 'https://__MSG_url_lang__.wikipedia.org/w/api.php?action=opensearch&search={searchTerms}'
    },
    'messages': {
      'url_landing': {'message': 'Special:Search'}
    }
  },
};

(async function run() {

  program
    .version('0.0.1')
    .option('-e, --engine [engine]', 'Engine')
    .option('--gecko-path [path]', 'Path to gecko')
    .option('--xpi <xpi>', 'The location to write the .xpi file')
    .parse(process.argv);

  let engine = program.engine;

  let conf = CONFIG[engine] || {};
  let manifest = Object.assign(MANIFEST, conf.manifest || {});
  let searchProvider = Object.assign(SEARCH_PROVIDER, conf.search_provider || {});

  // Temporary directory where we write the WebExtension files before
  // zipping them up.
  let tmpDir = 'tmp/';
  if (fs.existsSync(tmpDir)) {
    return console.error('Destination file', tmpDir, 'already exists');
  }

  let xpiPath = program.xpi || engine + '.xpi';

  let locales = [];

  let pathToOpenSearchFiles = program.geckoPath + SEARCHPLUGINS_FOLDER + engine + '*';
  let openSearchFiles = await glob(pathToOpenSearchFiles);

  if (!openSearchFiles.length) {
    return console.error('No files to convert found');
  }

  console.log('Found', openSearchFiles.length, 'files to process');

  fs.mkdirSync(tmpDir);
  fs.mkdirSync(tmpDir + '_locales/');

  for (const file of openSearchFiles) {
    // TODO: Check that we can always default to en
    let locale = file.slice(pathToOpenSearchFiles.length, -4) || 'en';
    locales.push(locale);

    let localeDir = tmpDir + '_locales/' + locale + '/';
    let searchFile = await convert.xmlFileToJSON(file);

    let messages = Object.assign({
      'extensionName': {'message': searchFile.SearchPlugin.ShortName[0]},
      'extensionDescription': {'message': searchFile.SearchPlugin.Description[0]},
      'url_lang': {'message': locale},
    }, conf.messages || {});

    fs.mkdirSync(localeDir);
    writeJSON(localeDir + 'messages.json', messages);
  }

  // We are just picking the first search file to pull the main values out of
  // (search_url, favicon etc). Maybe a way to improve would be to go through
  // all the locales, and if they are the same, use that value, if not prompt
  // the developer to construct a config value for them
  let exampleSearchFile = await convert.xmlFileToJSON(openSearchFiles[0]);


  // search_url
  if (!searchProvider.hasOwnProperty('search_url')) {
    let url = exampleSearchFile.SearchPlugin.Url[0].$.template;
    // WebExtensions do not allow http
    url = url.replace('http:', 'https:');

    let params = {};
    for (const param of exampleSearchFile.SearchPlugin.Url[0].Param) {
      params[param.$.name] = param.$.value
    }

    searchProvider.search_url = url +
      paramsToStr(exampleSearchFile.SearchPlugin.Url[0].Param);
  }

  // id: TODO: Check on what the right thing to do here is
  if (!manifest.applications.gecko.hasOwnProperty('id')) {
    manifest.applications.gecko.id = engine + '@mozilla.org';
  }


  // default_locale: If there is no default locale set in the manifest file
  // default to 'en' if available, otherwise just pick the first
  if (!manifest.hasOwnProperty('default_locale')) {
    manifest.default_locale = locales.includes('en') ? 'en' : locales[0];
  }

  // TODO: WebExtensions seem to not like data uris, might need to
  // these in the tree
  //if (!searchProvider.hasOwnProperty('favicon_url')) {
  //  searchProvider.favicon_url = exampleSearchFile.SearchPlugin.Image[0]._;
  //}

  manifest.chrome_settings_overrides = {"search_provider": searchProvider};
  writeJSON(tmpDir + 'manifest.json', manifest);

  await writeZip(tmpDir, xpiPath);
  // TODO: Commenting this out for debugging
  //await rmfr(tmpDir);

  console.log('Complete! written', xpiPath);
})();

function paramsToStr(openSearchParams) {
  let params = [];
  for (const param of openSearchParams) {
    params.push(param.$.name + '=' + param.$.value);
  }
  if (!params.length) {
    return '';
  }
  return '?' + params.join('&');
}

async function writeJSON(path, json) {
  var str = JSON.stringify(json, null, 2);
  fs.writeFileSync(path, str, 'utf8');
}

async function writeZip(path, file) {
  return new Promise((resolve, reject) => {
    zipFolder(path, file, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

