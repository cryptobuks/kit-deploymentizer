"use strict";

const _ = require("lodash");
const path = require("path");
const Promise = require("bluebird");
const yamlHandler = require("../util/yaml-handler");
const resourceHandler = require("../util/resource-handler");
const eventHandler = require("../util/event-handler");
const fse = require("fs-extra");
const fseCopy = Promise.promisify(fse.copy);
const fseMkdirs = Promise.promisify(fse.mkdirs);
const fseReadFile = Promise.promisify(fse.readFile);

/**
 * Creates the cluster directory if it already does not exist - async operation.
 * @param  {string} path to directory to create
 */
function createClusterDirectory(clusterPath) {
	// Try to make directory if it doesn't exist yet
	return yamlHandler.exists(clusterPath).then( (exists) => {
    if (!exists) {
  		fseMkdirs(clusterPath);
    }
  });
}

/**
 * Returns the file informtion including type based on ext and name.
 * @param  {[type]} file string containing the file name and ext.
 * @return {{extension, name}}      extention of the file indicating type.
 */
function fileInfo(file) {
	return path.parse(file);
}

/**
 * Manages generation of files for a given cluster definition.
 */
class Generator {

	constructor(clusterDef, imageResourceDefs, basePath, exportPath, save, configPlugin) {
		this.options = {
			clusterDef: clusterDef,
			imageResourceDefs: imageResourceDefs,
			basePath: basePath,
			exportPath: path.join(exportPath, clusterDef.name()),
			save: (save || false)
		};
    this.configPlugin = configPlugin;
	}

	/**
	 * Processes a given Cluster Definition, creating all the required files by
	 *   rendering the resource and service templates.
	 *
	 * Returns a Promise fulfilled after saving file(s)
	 */
	process() {
		return Promise.coroutine( function* () {
      eventHandler.emitInfo(`Calling process for ${this.options.clusterDef.name()}`);
  		// Create the output directory if it already does not exist.
		  yield createClusterDirectory(this.options.exportPath);
  		const resources = this.options.clusterDef.resources();
  		let promises = [];
      const keys = Object.keys(resources);
      for (let i=0; i<keys.length; i++) {
        const resourceName = keys[i];
        let resource = resources[resourceName];
        if (resource.disable === true) {
          eventHandler.emitWarn(`Resource ${resourceName} is disabled, skipping...`);
        } else {
    			eventHandler.emitInfo(`Creating LocalConfig for Resource :: ${resourceName}`);
    			let localConfig = yield this._createLocalConfiguration(this.options.clusterDef.configuration(), resourceName, resource);
          if (resource.file) {
            eventHandler.emitInfo(`Processing Resource ${resourceName}`);
            const fileStats = fileInfo(resource.file);
            switch (fileStats.ext) {
              case ".yaml":
                // YAML files do not need any processing - copy file to output directory
                yield this.processCopyResource(resource, fileStats);
                break;
              case ".mustache":
                // process and render template
                yield this.processResource(resource, localConfig, fileStats);
                break;
              default:
                throw new Error(`Unknown file type: ${fileStats.ext}`);
            }
          }
          if (resource.svc) {
      			eventHandler.emitInfo(`Processing Service ${resource.svc.name} `);
      			// Create local config for each resource, includes local envs, svc info and image tag
      			yield this.processService(resource, localConfig);
          }
        }
      }
    }).bind(this)();
	}

	/**
	 * Creates a local clone of the configuration object for a given resource.
	 * @param  {[type]} config       Initial configuration object
	 * @param  {[type]} resourceName Name of the resource
	 * @param  {[type]} resource
	 * @return {{}}              cloned copy of the configuration with resource specific attributes added.
	 */
	_createLocalConfiguration(config, resourceName, resource) {
		return Promise.coroutine( function* () {
      // clone local copy
  		let localConfig = _.cloneDeep(config);
      // if not not set at the resource level set it to the cluster default
  		localConfig.branch = (resource.branch || this.options.clusterDef.branch());
  		// Add the ResourceName to the config object.
  		localConfig.name = resourceName;

      // get Configuration from plugin
      // TODO: This will return other non-env values
      const envConfig = yield this.configPlugin.fetch( resourceName, this.options.clusterDef.type(), this.options.clusterDef.name() );
      // merge these in
      eventHandler.emitInfo(`LocalConfig before plugin merge for ${resourceName} :: ${JSON.stringify(localConfig)}`);
      eventHandler.emitInfo(`envConfig from plugin for ${resourceName} :: ${JSON.stringify(envConfig)}`);
      localConfig = resourceHandler.merge(localConfig, envConfig);
      eventHandler.emitInfo(`LocalConfig after plugin merge for ${resourceName} :: ${JSON.stringify(localConfig)}`);

  		// Check to see if the specific resource has its own envs and merge if needed.
  		if (resource.env) {
  			// Process any external ENV values before merging.
  			const env = resourceHandler.mergeEnvs(localConfig.env, resourceHandler.loadExternalEnv( resource.env ));
  			localConfig.env = env;
  		}

  		// Find the image tag name, if not defined skip
  		if (resource.image_tag) {
    		if ( !this.options.imageResourceDefs[resource.image_tag] || !this.options.imageResourceDefs[resource.image_tag][localConfig.branch] ) {
    			throw new Error(`Image ${resource.image_tag} not for for defined branch ${localConfig.branch}`);
    		}
    		localConfig.image = this.options.imageResourceDefs[resource.image_tag][localConfig.branch].image;
      } else {
        eventHandler.emitWarn(`No image tag found for ${resourceName}`);
      }
  		// if service info, append
  		if (resource.svc) {
  			localConfig.svc = resource.svc;
  		}
      eventHandler.emitInfo(`Local Config for ${resourceName} :: ${JSON.stringify(localConfig)}`);
  		return localConfig;
    }).bind(this)();
	}

	/**
	 * Renders the resource file and saves to the output directory.
	 * @param  {[type]} resource     to process
	 * @param  {[type]} localConfig  data to use when rendering templat
	 * @param  {[type]} fileStats    file information
	 * @return {[type]}           [description]
	 */
	processResource(resource, localConfig, fileStats) {
		return Promise.coroutine( function* () {
			eventHandler.emitInfo(`Processing Resource :: ${fileStats.base}`);
      try {

			const resourceTemplate = yield fseReadFile( path.join(this.options.basePath, resource.file), "utf8");
			const resourceYaml = resourceHandler.render(resourceTemplate, localConfig);
			if (this.options.save === true) {
				yield yamlHandler.saveResourceFile(this.options.exportPath, fileStats.name, resourceYaml);
			} else {
				eventHandler.emitInfo(`Saving is disabled, skipping ${fileStats.name}`);
			}
    } catch (e) {
      console.log(e);
    }
      return;
		}).bind(this)();
	}

	/**
	 * Copys the file from the current location to the output location
	 * @param  {[type]} resource  containing the file path to copy
	 * @param  {[type]} fileStats file information
	 * @return {[type]}           [description]
	 */
	processCopyResource(resource, fileStats) {
		return Promise.coroutine( function* () {
			eventHandler.emitInfo(`Copying file from ${path.join(this.options.basePath, resource.file)} to ${path.join(this.options.exportPath, fileStats.base)}`);
			if (this.options.save === true) {
				return yield fseCopy(path.join(this.options.basePath, resource.file), path.join(this.options.exportPath, fileStats.base));
			} else {
				eventHandler.emitInfo(`Saving is disabled, skipping ${fileStats.name}`);
				return;
			}
		}).bind(this)();
	}

	/**
	 * Process the Service File
	 * @param  {[type]} resource    [description]
	 * @param  {[type]} localConfig [description]
	 * @return {[type]}             [description]
	 */
	processService(resource, config) {
		return Promise.coroutine( function* () {
			// There may not be a service associated with this
			const serviceTemplate = yield fseReadFile(path.join(this.options.basePath, "resources", "base-svc.mustache"), "utf8");
			const svcYaml = resourceHandler.render(serviceTemplate, config);
			if (this.options.save === true) {
				yield yamlHandler.saveResourceFile(this.options.exportPath, resource.svc.name, svcYaml);
			} else {
				eventHandler.emitInfo(`Saving is disabled, skipping ${resource.svc.name}`);
			}
			return;
		}).bind(this)();
	}

}

module.exports = Generator;