#!/usr/bin/env node

// Convert Firefox builtin OpenSearch xml files into WebExtensions
//
//  $ opensearch-to-webext --gecko-path=/Users/dharvey/src/gecko/
//  $ opensearch-to-webext --gecko-path=/Users/dharvey/src/gecko/ --engine=allegro
//
// TODO:
//  * Yandex has 2 icons for different locales, WebExtensions assumes one icon
//    also WebExtensions dont seem to like the yandex icon

const fs = require('fs-extra')
const glob = require('glob-promise');
const program = require('commander');
const convert = require('xml-to-json-promise');
const zipFolder = require('zip-folder');
const rimraf = require('rimraf');
const mkdirp = require('async-mkdirp');
const rmfr = require('rmfr');
const querystring = require('querystring');
const dataUriToBuffer = require('data-uri-to-buffer');

const SEARCHPLUGINS_FOLDER = 'browser/components/search/searchplugins/';
const ICON_RESOURCES = 'browser/components/search/searchplugins/images/';

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
  'name': '__MSG_extensionName__',
  'search_url': '__MSG_searchUrl__'
};

/*
 * Here we can define specific properties for individual engines, things that cant
 * be infered from the OpenSearch files, the 'manifest' and 'search_provider'
 * fields will override the above definitions
 */
const CONFIG = {

  'wikipedia': {
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

async function parseEngine(engine, geckoPath, xpi) {

  let conf = CONFIG[engine] || {};
  let manifest = Object.assign(copy(MANIFEST), copy(conf.manifest));
  let searchProvider = Object.assign(copy(SEARCH_PROVIDER), copy(conf.search_provider));

  // Temporary directory where we write the WebExtension files before
  // zipping them up.
  let tmpDir = 'tmp/' + engine + '/';
  if (fs.existsSync(tmpDir)) {
    return console.error('Destination file', tmpDir, 'already exists');
  }

  let xpiPath = xpi || 'dist/' + engine + '.xpi';
  await mkdirp('dist/');

  let locales = [];
  let pathToOpenSearchFiles = geckoPath + SEARCHPLUGINS_FOLDER + engine + '*.xml';
  let openSearchFiles = await glob(pathToOpenSearchFiles);

  if (!openSearchFiles.length) {
    return console.error('No files to convert found');
  }

  console.log('Processing ' + engine + '. Found', openSearchFiles.length,
              'files to process');

  await mkdirp(tmpDir);
  await mkdirp(tmpDir + '_locales/');

  let hasSuggest = false;

  for (const file of openSearchFiles) {
    // files that arent in file-locale.xml format
    let exceptions = /(google-2018|bbc-alba|yahoo-jp-auctions)/;
    let index = exceptions.test(file) ? -1 : file.indexOf('-');
    let locale = (index != -1) ? file.slice(index + 1, -4) : 'en';
    if (/yahoo-jp-auctions/.test(file)) {
      locale = 'jp';
    }
    if (/amazondotcn/.test(file)) {
      locale = 'cn';
    }
    locales.push(locale);

    let localeDir = tmpDir + '_locales/' + locale + '/';
    let fileData = fs.readFileSync(file, 'utf8');
    let match = /<SearchPlugin|<OpenSearchDescription/.exec(fileData);
    fileData = fileData.slice(match.index);
    let searchFile = await convert.xmlDataToJSON(fileData);
    let searchPlugin = searchFile.SearchPlugin || searchFile.OpenSearchDescription;

    let messages = Object.assign({
      'extensionName': {'message': searchPlugin.ShortName[0]},
      'extensionDescription': {'message': searchPlugin.Description[0]},
      'url_lang': {'message': locale},
      'searchUrl': {'message': getSearchUrl(searchPlugin).url}
    }, copy(conf.messages));

    let suggestUrl = getSuggestUrl(searchPlugin);
    if (suggestUrl) {
      messages.suggestUrl = {'message': suggestUrl.url};
      hasSuggest = true;
    }

    await mkdirp(localeDir);
    writeJSON(localeDir + 'messages.json', messages);
  }

  // We are just picking the first search file to pull the main values out of
  // (search_url, favicon etc). Maybe a way to improve would be to go through
  // all the locales, and if they are the same, use that value, if not prompt
  // the developer to construct a config value for them
  let exampleSearchFile = await convert.xmlFileToJSON(openSearchFiles[0]);
  let searchPlugin = exampleSearchFile.SearchPlugin ||
      exampleSearchFile.OpenSearchDescription;

  if (hasSuggest) {
    searchProvider.suggest_url = '__MSG_suggestUrl__';
  }

  if (!manifest.applications.gecko.hasOwnProperty('id')) {
    manifest.applications.gecko.id = engine + '@mozilla.org';
  }


  // default_locale: If there is no default locale set in the manifest file
  // default to 'en' if available, otherwise just pick the first
  if (!manifest.hasOwnProperty('default_locale')) {
    manifest.default_locale = locales.includes('en') ? 'en' : locales[0];
  }


  if (!manifest.hasOwnProperty('icons')) {
    let imageUri = searchPlugin.Image[0]._.trim();
    if (imageUri.startsWith('http')) {
      searchProvider.favicon_url = imageUri;
    } else if (imageUri.startsWith('data')) {
      let buffer = dataUriToBuffer(imageUri);
      let extension  = typeToExtension(buffer.type);
      let path = tmpDir + 'favicon.' + extension;
      await fs.writeFile(path, buffer);
      manifest.icons = {
        '16': 'favicon.' + extension
      };
    } else if (imageUri.startsWith('resource')) {
      let path = geckoPath + ICON_RESOURCES + imageUri.split('/').pop();
      let target = tmpDir + 'favicon' + imageUri.substr(-4);
      await fs.copy(path, target);
      manifest.icons = {
        '16': 'favicon' + imageUri.substr(-4)
      };

    } else {
      console.warn('Unsupported image type', imageUri);
    }
  }


  manifest.chrome_settings_overrides = {
    'search_provider': searchProvider
  };

  await writeJSON(tmpDir + 'manifest.json', manifest);
  await writeZip(tmpDir, xpiPath);

  console.log('Complete! written', xpiPath);
};

function typeToExtension(type) {
  return {
    'image/x-icon': 'ico',
    'image/png': 'png'
  }[type];
}

function getSearchUrl(searchPlugin) {
  return parseUrlObj(searchPlugin.Url.find(obj => {
    return obj.$.type !== 'application/x-suggestions+json';
  }));
}

function getSuggestUrl(searchPlugin) {
  let obj = searchPlugin.Url.find(obj => {
    return obj.$.type === 'application/x-suggestions+json';
  });

  return obj ? parseUrlObj(obj) : false;
}

function parseUrlObj(urlObj) {
  let result = {
    url: urlObj.$.template.replace('http:', 'https:')
  };

  if (urlObj.Param && urlObj.$.method !== 'POST') {
    let params = [];
    for (const param of urlObj.Param) {
      params.push(param.$.name + '=' + param.$.value);
    }
    let prepend = (result.url.indexOf('?') === -1) ? '?' : '';
    result.url +=  prepend + params.join('&');
  }

  if (urlObj.Param && urlObj.$.method === 'POST') {
    let params = [];
    for (const param of urlObj.Param) {
      params.push(param.$.name + '=' + param.$.value);
    }
    result.post_params = params.join('&');
  }

  if (urlObj.MozParam) {
    let params = urlObj.MozParam.map(param => {
      let obj = {};
      obj[param.$.name] = param.$.value;
      return obj;
    });
    if (params.length) {
      result.params = params;
    }
  }
  return result;
}

function copy(obj) {
  if (!obj) {
    return {};
  }
  return JSON.parse(JSON.stringify(obj));
}

async function writeJSON(path, json) {
  var str = JSON.stringify(json, null, 2);
  return fs.writeFileSync(path, str, 'utf8');
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

async function allEngines(program) {
  let openSearchFiles = await glob(program.geckoPath + SEARCHPLUGINS_FOLDER  + '*.xml');
  let engines = [...new Set(openSearchFiles.map(file => {
    return file.split('/').pop().split('-')[0].replace('.xml', '');
  }))];

  // Gets dedupped incorrectly
  engines.push('google-2018');
  engines.push('yahoo-jp-auctions');

  for (var i in engines) {
    await parseEngine(engines[i], program.geckoPath);
  }
}

program
  .version('0.0.1')
  .option('-e, --engine [engine]', 'Engine')
  .option('--gecko-path [path]', 'Path to gecko')
  .option('--xpi <xpi>', 'The location to write the .xpi file')
  .parse(process.argv);

if (!program.engine) {
  allEngines(program);
} else {
  parseEngine(program.engine, program.geckoPath, program.xpi);
}
