"use strict";

const _ = require("lodash");
const path = require("path");
const Promise = require("bluebird");
const Generator = require("./generator");
const yamlHandler = require("../util/yaml-handler");
const EventHandler = require("../util/event-handler");
const PluginHandler = require("../util/plugin-handler");
const logger = require("log4js").getLogger();
const fse = require("fs-extra");
const fseRemove = Promise.promisify(fse.remove);
const request = require("request-promise");
const errors = require("request-promise/errors");

logger.setLevel((process.env.DEBUG === "true" ? "DEBUG" : "ERROR"));

const resolve = function(workdir, pathStr) {
		if (!pathStr) {
			return undefined;
		}
		return path.resolve(workdir, pathStr);
}

/**
 * Main class used to process deployment files converting templates into deployable manifests.
 */
class Deploymentizer {
	constructor(args) {
		// define require fields
		this.paths = {
			base: undefined,
			output: undefined,
			cluster: undefined,
			images: undefined,
			type: undefined
		}
		this.options = {
				elroyUrl: (args.elroyUrl || null),
				elroySecret: (args.elroySecret || null),
				clean: (args.clean || false),
				save: (args.save || false),
				workdir: (args.workdir || ""),
				configPlugin: undefined,
				conf: undefined,
				resource: (args.resource || undefined),
				clusterType: (args.clusterType || undefined)
			}
		this.options.conf = this.parseConf(args.conf);
		this.events = new EventHandler();
;
	}

	/**
	 * Main entrypoint. Handles loading var files and cluster definitions. These
	 * are merged before rendering the deployment manifests.
	 */
	process() {
		return Promise.coroutine(function* () {

			this.events.emitInfo(`Running for cluster ${this.options.clusterType} and resource ${this.options.resource || "all"}`);

			if (this.options.clean) {
				this.events.emitDebug(`Cleaning: ${path.join(this.paths.output, "/*")}`);
				yield fseRemove(path.join(this.paths.output, "/*"));
			}

			this.events.emitDebug(`Loading base cluster definitions from: ${this.paths.base}`);
			const baseClusterDef = yield yamlHandler.loadBaseDefinitions(this.paths.base);

			// Load the type configs into their own Map
			const typeDefinitions = yield yamlHandler.loadTypeDefinitions(this.paths.type);

			// Load image tag (usage based on Resource Spec or cluster spec
			const imageResources = yield yamlHandler.loadImageDefinitions(this.paths.images);

			let configPlugin = undefined;
			if (this.options.configPlugin) {
				configPlugin = new PluginHandler(this.options.configPlugin.path, this.options.configPlugin.options);
			}
			// Load the /cluster 'cluster.yaml' and 'configuration-var.yaml'
			const clusterDefs = yield yamlHandler.loadClusterDefinitions(this.paths.cluster);

			//Merge the definitions, render templates and save (if enabled)
			let processClusters = [];
			for (let i=0; i < clusterDefs.length; i++) {
				processClusters.push(this.processClusterDef( clusterDefs[i], typeDefinitions, baseClusterDef, imageResources, configPlugin ));
				if (this.options.elroyUrl && this.options.elroySecret) {
					processClusters.push(this.saveToElroy(clusterDefs[i]));
				}
			};
			yield Promise.all(processClusters);
			this.events.emitInfo(`Finished processing files...` );
		}).bind(this)();
	}

	/**
	 * Load the conf file if available and merge values.
	 */
	parseConf(conf) {
		if (conf) {
			this.paths.base = resolve(this.options.workdir, conf.base.path);
			this.paths.output = resolve(this.options.workdir, conf.output.path);
			this.paths.cluster = resolve(this.options.workdir, conf.cluster.path);
			this.paths.resources = resolve(this.options.workdir, conf.resources.path);
			this.paths.type = resolve(this.options.workdir, conf.type.path);
			this.paths.images = resolve(this.options.workdir, conf.images.path);
			if (conf.plugin) {
				this.options.configPlugin = conf.plugin;
				this.options.configPlugin.path = conf.plugin.path;
			}
			Object.keys(this.paths).forEach( (key) => {
				if (!this.paths[key]) {
					throw new Error (`Missing required value: ${key}`);
				}
			});
		} else {
			throw new Error("No Configuration object.");
		}
	}

	/**
	 * Process files for a given cluster. This includes merging configuration files, and rendering templates.
	 *
	 * @param  {[type]} def             Cluster Definition
	 * @param  {[type]} typeDefinitions Map of Type configuration
	 * @param  {[type]} baseClusterDef  Base Cluster Definition
	 * @param  {[type]} imageResources  ImageResource Map
	 */
	processClusterDef(def, typeDefinitions, baseClusterDef, imageResources, configPlugin) {
		return Promise.try( () => {
			if (def.type()) {
				if (this.options.clusterType != undefined && this.options.clusterType !== def.type()) {
					this.events.emitDebug(`Only processing cluster type ${this.options.clusterType}, cluster ${def.name()} is ${def.type()}, skipping...` );
					return;
				}
				const type = typeDefinitions[def.type()];
				if (!type) { throw new Error(`UnSupported Type ${def.type()}`); }
				// Merge the type definition then the base definition
				def.apply(type);
			} else {
				this.events.emitError(`No Type configured for cluster ${def.name()}, stopping...` );
				throw new Error(`No Type found for cluster ${def.name()}`);
			}
			// Merge with the Base Definitions.
			def.apply(baseClusterDef);
			this.events.emitDebug("Done Merging Cluster Definitions");
			if (def.disabled()) {
				this.events.emitInfo(`Cluster ${def.name()} is disabled, skipping...`);
				return;
			} else {
				// apply the correct image tag based on cluster type or resource type
				// generating the templates for each resource (if not disabled), using custom ENVs and envs from resource tags.
				// Save files out
				const generator = new Generator(def, imageResources,
																				this.paths.resources,
																				this.paths.output,
																				this.options.save,
																				configPlugin,
																				this.options.resource,
																				this.events);
				return generator.process();
			}
		});
	}
	
	/**
	 * Saves the given cluster defination to an external Elroy instance. Returns a promise that is resolved on success.
	 *
	 * @param {[type]} def          Cluster Definition
	 */
	saveToElroy(def) {
		return Promise.try(() => {
			this.events.emitInfo(`Saving Cluster ${def.metadata.name} to Elroy...`);
			// Format for elroy
			const cluster = {
				name: def.cluster.metadata.name,
				tier: def.cluster.metadata.type,
				active: (def.cluster.metadata.active || true), // Clusters are active by default
				metadata: {
					type: (def.cluster.metadata.type || null),
					environment: (def.cluster.metadata.environment || null),
					domain: (def.cluster.metadata.domain || null),
					company: (def.cluster.metadata.company || null)
				},
				kubernetes: {
					cluster: def.cluster.metadata.cluster,
					namespace: def.cluster.metadata.namespace,
					ingress: (def["ingress-controller"] || null)
				},
				resources: (def.cluster.resources || [])
			};
			return request({
				simple: true,
				method: "POST",
				uri: this.options.elroyUrl + "/api/v1/deployment-environment/" + def.cluster.metadata.name,
				headers: {
					"X-Auth-Token": this.options.elroySecret
				},
				body: cluster,
				json: true
			}).catch(errors.StatusCodeError, function (reason) {
				// If error is because it already exists, lets do an update
				if (reason.response.statusCode == 409) {
					return request({
						method: "PUT",
						uri: this.options.elroyUrl + "/api/v1/deployment-environment/" + def.cluster.metadata.name,
						headers: {
							"X-Auth-Token": this.options.elroySecret
						},
						body: cluster,
						json: true
					});
				}
				return null;
			});
		});
	}
}

module.exports = Deploymentizer;
