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

const SEARCHPLUGINS_FOLDER = 'mail/components/search/searchplugins/';
const ICON_RESOURCES = 'mail/components/search/searchplugins/images/';

const MULTILOCALE = true;

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
  'search_url': '__MSG_searchUrl__',
};

/*
 * Here we can define specific properties for individual engines, things that cant
 * be infered from the OpenSearch files, the 'manifest' and 'search_provider'
 * fields will override the above definitions
 */
const CONFIG = {
};

function normaliseLocale(file) {
  let filename = file.split('/').pop();
  if (filename.indexOf('-') === -1) {
    return 'en';
  }
  let locale = filename.slice(filename.indexOf('-') + 1, -4);
  return locale;
}

function paramsToStr(obj) {
  let params = [];
  for (const param of obj) {
    params.push(param.name + '=' + param.value);
  }
  return params.join('&');
}

function getSearchForm(searchPlugin) {
  if (searchPlugin.SearchForm) {
    return searchPlugin.SearchForm[0];
  }

  let obj = searchPlugin.Url.find(obj => {
    return obj.$.rel == 'searchform';
  });

  if (!obj) { return false; }

  let url = parseUrlObj(obj);

  let actualUrl = url.url;
  if (url.params) {
    let prepend = (actualUrl.indexOf('?') === -1) ? '?' : '';
    actualUrl += prepend + paramsToStr(url.params);
  }

  return actualUrl;
}

async function singleLocaleExtension(engine, geckoPath, file) {

  console.log('processing: ' + engine);

  engine = file.split('/').pop().replace('.xml', '');
  let tmpDir = 'tmp/' + engine + '/';
  await mkdirp(tmpDir);

  let conf = CONFIG[engine] || {};
  let manifest = Object.assign(copy(MANIFEST), copy(conf.manifest));
  let searchProvider = Object.assign(copy(SEARCH_PROVIDER), copy(conf.search_provider));

  let fileData = fs.readFileSync(file, 'utf8');
  let match = /<SearchPlugin|<OpenSearchDescription/.exec(fileData);
  fileData = fileData.slice(match.index);
  let searchFile = await convert.xmlDataToJSON(fileData);
  let searchPlugin = searchFile.SearchPlugin || searchFile.OpenSearchDescription;

  manifest.hidden = true;

  searchProvider.name = searchPlugin.ShortName[0];
  manifest.name = searchPlugin.ShortName[0];
  if (getSearchForm(searchPlugin)) {
    searchProvider.search_form = getSearchForm(searchPlugin);
  }

  let searchUrl = getSearchUrl(searchPlugin);
  searchProvider.search_url = searchUrl.url;

  if (searchUrl.params) {
    searchProvider.search_url_get_params = paramsToStr(searchUrl.params);
  }

  if (searchUrl.mozParams.length) {
    searchProvider.params = searchUrl.mozParams;
  }

  if (searchUrl.post_params) {
    searchProvider.search_url_post_params = searchUrl.post_params;
  }

  let suggestUrl = getSuggestUrl(searchPlugin);
  if (suggestUrl) {
    searchProvider.suggest_url = suggestUrl.url;
    if (suggestUrl.params) {
      searchProvider.suggest_url_get_params = paramsToStr(suggestUrl.params);
    }
  }

  manifest.description = searchPlugin.Description[0];

  if (!manifest.applications.gecko.hasOwnProperty('id')) {
    manifest.applications.gecko.id = engine + '@search.mozilla.org';
  }

  if (!manifest.hasOwnProperty('icons') && searchPlugin.Image) {
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

  manifest.web_accessible_resources = [manifest.icons['16']];

  manifest.chrome_settings_overrides = {
    'search_provider': searchProvider
  };

  await writeJSON(tmpDir + 'manifest.json', manifest);

  console.log('Complete! written: ' + manifest.name);
}

async function parseEngine(engine, geckoPath, xpi) {

  if (engine === "yahoo") return;

  let conf = CONFIG[engine] || {};
  let manifest = Object.assign(copy(MANIFEST), copy(conf.manifest));
  let searchProvider = Object.assign(copy(SEARCH_PROVIDER), copy(conf.search_provider));

  let locales = [];
  let pathToOpenSearchFiles = geckoPath + SEARCHPLUGINS_FOLDER + engine + '*.xml';

  let openSearchFiles = await glob(pathToOpenSearchFiles);
  if (engine === 'yahoo-jp') {
    openSearchFiles = [geckoPath + SEARCHPLUGINS_FOLDER + 'yahoo-jp.xml'];
  } else if (engine === 'amazon') {
    openSearchFiles = openSearchFiles.filter(file => {
      return !/amazondotcom/.test(file) && !/amazondotcn/.test(file);
    });
  }

  if (!openSearchFiles.length) {
    return console.error('No files to convert found');
  }

  if (openSearchFiles.length === 1) {
    return singleLocaleExtension(engine, geckoPath, openSearchFiles[0]);
  }

  console.log('Processing ' + engine + '. Found', openSearchFiles.length,
              'files to process');

  let tmpDir = 'tmp/' + engine + '/';
  if (fs.existsSync(tmpDir)) {
    return console.error('Destination file', tmpDir, 'already exists');
  }
  await mkdirp(tmpDir);

  let hasSuggest = false;
  let icons = [];
  let mozParams = [];

  let fileData = fs.readFileSync(openSearchFiles[0], 'utf8');
  let match = /<SearchPlugin|<OpenSearchDescription/.exec(fileData);
  fileData = fileData.slice(match.index);
  // let searchFile = await convert.xmlDataToJSON(fileData);
  // let searchPlugin = searchFile.SearchPlugin || searchFile.OpenSearchDescription;

  for (const file of openSearchFiles) {
    let locale = normaliseLocale(file);
    locales.push(locale);
    let localeDir = tmpDir + '_locales/' + locale + '/';
    let fileData = fs.readFileSync(file, 'utf8');
    let match = /<SearchPlugin|<OpenSearchDescription/.exec(fileData);
    fileData = fileData.slice(match.index);
    let searchFile = await convert.xmlDataToJSON(fileData);
    let searchPlugin = searchFile.SearchPlugin || searchFile.OpenSearchDescription;

    let searchUrl = getSearchUrl(searchPlugin);

    let messages = Object.assign({
      'extensionName': {'message': searchPlugin.ShortName[0]},
      'extensionDescription': {'message': searchPlugin.Description[0]},
      'searchUrl': {'message': searchUrl.url},
      'searchForm': {'message': getSearchForm(searchPlugin)},
    }, copy(conf.messages));

    let suggestUrl = getSuggestUrl(searchPlugin);
    if (suggestUrl) {
      hasSuggest = true;
      messages.suggestUrl = {'message': suggestUrl.url};
      if (suggestUrl.params) {
        let prepend = (messages.suggestUrl.message.indexOf('?') === -1) ? '?' : '';
        messages.suggestUrl.message += prepend + paramsToStr(suggestUrl.params);
      }
    }

    if (searchUrl.params) {
      messages.searchUrlGetParams = {'message': paramsToStr(searchUrl.params)};
    }

    if (searchUrl.mozParams.length) {
      //mozParamsmozParams.concat(searchUrl.mozParams);
      searchUrl.mozParams.forEach(param => {

        // So far only yandex have mozParams and for them purpose is unique enough
        if (param.purpose) {
          messages['param_' + param.purpose] = {'message': param.value};
        }
      });
    }

    if (searchUrl.post_params) {
      throw 'fuck';
      //messages.search_url_post_params = {'message': searchUrl.post_params};
    }

    if (engine === 'yandex') {
      messages.extensionIcon = {'message': searchPlugin.Image[0]._};
    }

    await mkdirp(localeDir);
    writeJSON(localeDir + 'messages.json', messages);
  }

  // All the multilocale engines have a searchform
  searchProvider.search_form = '__MSG_searchForm__';

  // We are just picking the first search file to pull the main values out of
  // (search_url, favicon etc). Maybe a way to improve would be to go through
  // all the locales, and if they are the same, use that value, if not prompt
  // the developer to construct a config value for them
  let exampleSearchFile = await convert.xmlFileToJSON(openSearchFiles[0]);
  let searchPlugin = exampleSearchFile.SearchPlugin ||
      exampleSearchFile.OpenSearchDescription;

  if (hasSuggest) {
    searchProvider.suggest_url = "__MSG_suggestUrl__";
  }

  let searchUrl = getSearchUrl(searchPlugin);
  if (searchUrl.mozParams.length) {
    searchProvider.params = searchUrl.mozParams.map(param => {
      param.value = "__MSG_param_" + param.purpose;
      return param;
    });
  }

  if (searchUrl.params) {
    searchProvider.search_url_get_params = "__MSG_searchUrlGetParams__";
  }

  manifest.hidden = true;
  // if (searchPlugin.Description) {
  //   manifest.description = searchPlugin.Description[0];
  // }
  //searchProvider.name = searchPlugin.ShortName[0];
  //manifest.name = searchPlugin.ShortName[0];

  //let searchUrl = getSearchUrl(searchPlugin);
  //searchProvider.search_url = searchUrl.url;

  // if (searchUrl.params) {
  //   searchProvider.params = searchUrl.params;
  // }
  // if (searchUrl.post_params) {
  //   searchProvider.search_url_post_params = searchUrl.post_params;
  // }

  // let name = engine.split('-')[0];

  // let imageUri = searchPlugin.Image[0]._.trim();
  // if (imageUri.startsWith('data')) {
  //   let buffer = dataUriToBuffer(imageUri);
  //   let extension  = typeToExtension(buffer.type);
  //   let path = 'tmp/images/' + name + '.' + extension;
  //   await fs.writeFile(path, buffer);
  //   manifest.icons = {
  //     '16': 'resource://search-extensions/images/' + name + '.' + extension
  //   };
  // } else if (imageUri.startsWith('resource')) {
  //   let fileName = imageUri.split('/').pop();
  //   fs.copyFileSync(geckoPath + 'browser/components/search/searchplugins/images/' + fileName, 'tmp/images/' + fileName);
  //   manifest.icons = {
  //     '16': 'resource://search-extensions/images/' + fileName
  //   };
  // } else {
  //   throw 'Unknown image url: ' + imageUri;
  // }
  // if (!manifest.hasOwnProperty('icons')) {
  //   manifest.icons = {
  //     '16': 'resource://search-extensions/images/' + name + '.ico'
  //   };
  // }

  // let suggestUrl = getSuggestUrl(searchPlugin);
  // if (suggestUrl) {
  //   searchProvider.suggest_url = suggestUrl.url;
  //   if (suggestUrl.params) {
  //     let prepend = (searchProvider.suggest_url.indexOf('?') === -1) ? '?' : '';
  //     searchProvider.suggest_url += paramsToStr(suggestUrl.params);
  //   }
  // }

  if (!manifest.applications.gecko.hasOwnProperty('id')) {
    manifest.applications.gecko.id = engine + '@search.mozilla.org';
  }

  // default_locale: If there is no default locale set in the manifest file
  // default to 'en' if available, otherwise just pick the first
  if (!manifest.hasOwnProperty('default_locale')) {
    manifest.default_locale = locales.includes('en') ? 'en' : locales[0];
  }

  if (engine === 'yandex') {
    manifest.icons = {'16': '__MSG_extensionIcon__'};
    manifest.web_accessible_resources = ['yandex-en.ico', 'yandex-ru.ico'];
  }

  if (!manifest.hasOwnProperty('icons') && searchPlugin.Image) {
    let imageUri = searchPlugin.Image[0]._.trim();
    if (imageUri.startsWith('http')) {
      searchProvider.favicon_url = imageUri;
    } else if (imageUri.startsWith('data')) {
      // manifest.icons = {
      //   '16': imageUri
      // };
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

  if (!manifest.hasOwnProperty('web_accessible_resources')) {
    manifest.web_accessible_resources = [manifest.icons['16']];
  }

  manifest.chrome_settings_overrides = {
    'search_provider': searchProvider
  };

  await writeJSON(tmpDir + 'manifest.json', manifest);

  console.log('Complete! written');
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
    url: urlObj.$.template
  };

  let params = [];
  let mozParams = [];

  if (urlObj.Param && urlObj.$.method !== 'POST') {
    params = urlObj.Param.map(param => {
      return param.$;
    });
  }

  if (urlObj.Param && urlObj.$.method === 'POST') {
    let postParams = [];
    for (const param of urlObj.Param) {
      postParams.push(param.$.name + '=' + param.$.value);
    }
    result.post_params = postParams.join('&');
  }

  if (urlObj.MozParam) {
    mozParams = urlObj.MozParam.map(param => {
      return param.$;
    });
  }

  if (params.length) {
    result.params = params;
  }

  if (mozParams) {
    result.mozParams = mozParams;
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
    //return file.split('/').pop().replace('.xml', '');
    // 1 extension for many locales
    if (MULTILOCALE) {
      return file.split('/').pop().split('-')[0].replace('.xml', '');
    } else {
      return file.split('/').pop().replace('.xml', '');
    }
  }))];

  // Gets dedupped incorrectly
  // engines.push('google-b-1-d');
  // engines.push('google-b-1-e');
  // engines.push('google-b-d');
  // engines.push('google-b-e');
  // engines.push('google-2018');
  engines.push('yahoo-jp');
  engines.push('yahoo-jp-auctions');
  // engines.push('amazon-france');

  for (var i in engines) {
    if (MULTILOCALE) {
      await parseEngine(engines[i], program.geckoPath);
    }
  }
}



program
  .version('0.0.1')
  .option('-t, --test', 'Test files')
  .option('-e, --engine [engine]', 'Engine')
  .option('--gecko-path [path]', 'Path to gecko')
  .option('--xpi <xpi>', 'The location to write the .xpi file')
  .parse(process.argv);

if (!program.engine) {
  allEngines(program);
} else {
  parseEngine(program.engine, program.geckoPath, program.xpi);
}

// rm -rf tmp/ && node index.js --gecko-path=/Users/dharvey/src/gecko/
// rm -rf /Users/dharvey/src/gecko/browser/components/search/extensions/* && cp -R tmp/* /Users/dharvey/src/gecko/browser/components/search/extensions/ && cp ~/src/gecko/browser/components/search/searchplugins/list.json ~/src/gecko/browser/components/search/extensions/
