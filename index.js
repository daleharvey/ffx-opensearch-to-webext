#!/usr/bin/env node

// Convert Firefox builtin OpenSearch xml files into WebExtensions
//
//  $ opensearch-to-webext --gecko-path=/Users/dharvey/src/gecko/
//  $ opensearch-to-webext --gecko-path=/Users/dharvey/src/gecko/ --engine=allegro
//

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
  'yandex': {
    'manifest': {
      'icons': {
        '16': '__MSG_extensionIcon__'
      }
    }
  },
};


const VALID_LOCALES = [
  'jp', 'sk', 'tr', 'ru', 'kk', 'en', 'by', 'az', 'pl', 'oc', 'te',
  'zh_TW', 'zh_CN', 'wo', 'vi', 'uz', 'ur', 'uk', 'tl', 'th', 'ta',
  'sv_SE', 'sr', 'sq', 'sl', 'si', 'ro', 'en_US', 'rm', 'pt', 'pa',
  'or', 'NO', 'NN', 'nl', 'ne', 'my', 'ms', 'mr', 'ml', 'mk', 'lv',
  'ltg', 'lt', 'lo', 'lij', 'kr', 'af', 'an', 'ar', 'as', 'ast', 'be_tarask',
  'be', 'bg', 'bn', 'br', 'bs', 'ca', 'crh', 'cy', 'cz', 'da', 'de',
  'dsb', 'el', 'eo', 'es', 'et', 'eu', 'fa', 'fi', 'fr', 'fy_NL', 'ga_IE',
  'gd', 'gl', 'gn', 'gu', 'he', 'hi', 'hr', 'hsb', 'hu', 'hy', 'ia', 'id',
  'is', 'it', 'ja', 'ka', 'kab', 'km', 'kn', 'au', 'en_GB','in', 'mx', 'en_hu',
  'eo', 'ee', 'at', 'ch', 'ie', 'cn', 'gd_GB'
];

const LOCALE_OVERRIDES = {
  'bbc-alba.xml': 'gd_GB',
  'baidu.xml': 'cn',
  'azerdict.xml': 'az',
  'amazondotcom.xml': 'en_US',
  'cnrtl-tlfi-fr.xml': 'fr',
  'google-2018.xml': 'en_US',
  'amazondotcn.xml': 'cn',
  'amazon-france.xml': 'fr',
  'oshiete-goo.xml': 'jp',
  'reta-vortaro.xml': 'eo',
  'yahoo-jp-auctions.xml': 'jp',
  'wikipedia.xml': 'en'
};

function normaliseLocale(file) {
  let filename = file.split('/').pop();
  let locale = file.slice(file.indexOf('-') + 1, -4).replace('-', '_');

  if (filename in LOCALE_OVERRIDES) {
    locale = LOCALE_OVERRIDES[filename];
  }

  if (!VALID_LOCALES.includes(locale)) {
    return 'en';
  }

  return locale;
}

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
  let icons = [];

  for (const file of openSearchFiles) {
    let locale = normaliseLocale(file);
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

    if (engine === 'yandex') {
      messages.extensionIcon = {'message': searchPlugin.Image[0]._};
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

  if (hasSuggest && !('suggest_url' in searchProvider)) {
    searchProvider.suggest_url = '__MSG_suggestUrl__';
  }

  if (!manifest.applications.gecko.hasOwnProperty('id')) {
    manifest.applications.gecko.id = engine + '@search.mozilla.org';
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
  let extensions = {
    'image/ico': 'ico',
    'image/icon': 'ico',
    'image/x-ico': 'ico',
    'image/x-icon': 'ico',
    'image/png': 'png',
    'image/gif': 'gif',
  };
  if (type in extensions) {
    return extensions[type];
  }
  throw `Cant find ${type}`;

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
    // 1 extension per locale
    return file.split('/').pop().replace('.xml', '');
    // 1 extension for many locales
    //return file.split('/').pop().split('-')[0].replace('.xml', '');
  }))];

  // Gets dedupped incorrectly
  // engines.push('google-b-1-d');
  // engines.push('google-b-1-e');
  // engines.push('google-b-d');
  // engines.push('google-b-e');
  // engines.push('google-2018');
  // engines.push('yahoo-jp-auctions');
  // engines.push('amazon-france');

  for (var i in engines) {
    await parseEngine(engines[i], program.geckoPath);
  }

  //console.log(engines.map(engine => { return "    '"+engine+"',";}).join('\n'))
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
