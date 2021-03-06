"use strict";

var path = require("path");
var fs = require("fs");

var dotenv = require("dotenv");
var micromatch = require("micromatch");
var minimist = require("minimist");
var mkdirp = require("mkdirp");
var recursiveReadDir = require("recursive-readdir-sync");

var programVersion;
var { build, bundleUMD, umdIndex, esmIndex, defaultLibConfig, } = require("./index.js");
var {
	expandHomeDir,
	addRelativeCurrentDir,
	splitPath,
	isDirectory,
	checkPath,
	generateName,
} = require("./helpers.js");

dotenv.config();

var params = minimist(process.argv.slice(2),{
	boolean: [ "help","version","build-esm","build-umd","recursive", ],
	string: [ "config","from","to","bundle-umd", ],
	alias: {
		"config": "c",
		"recursive": "r",
		"build-esm": "e",
		"build-umd": "u",
		"bundle-umd": "b",
		"dep-map": "m",
	},
	default: {
		help: false,
		version: false,
		recursive: false,
		"build-esm": false,
		"build-umd": false,
	},
});
var RCPATH = resolvePath(params.config || process.env.RCPATH || "./.mzrc");

// initial CLI-config before reading from rc
var config = defaultCLIConfig();

module.exports = CLI;
module.exports.CLI = CLI;


// ******************************

function CLI(version = "0.0.0?") {
	programVersion = version;

	if (!loadConfig()) {
		return;
	}

	// populate known-dependencies map from configuration (if any)
	var knownDeps = {};
	if (config.depMap) {
		for (let [ depPath, depName, ] of Object.entries(config.depMap)) {
			let [ , relativePath, ] = splitPath(config.from,depPath);
			relativePath = addRelativeCurrentDir(relativePath);
			knownDeps[relativePath] =
				(typeof depName == "string" && depName != "") ? depName : generateName();
		}
	}

	// add discovered input files to known-depenedencies map
	var inputFiles = getInputFiles();
	for (let [ , relativePath, ] of inputFiles) {
		if (!(relativePath in knownDeps)) {
			knownDeps[relativePath] = generateName();
		}
	}

	var umdBuilds = [];
	var esmBuilds = [];

	try {
		// build each file (for each format)
		for (let [ basePath, relativePath, ] of inputFiles) {
			let code = fs.readFileSync(path.join(basePath,relativePath),"utf-8");
			let res = build(config,relativePath,code,knownDeps);

			// save UMD build (for bundling and/or catch-all generation)?
			if (
				res.umd &&
				(
					config.bundleUMDPath ||
					config.generateIndex
				)
			) {
				umdBuilds.push(res.umd);
			}
			// save ESM build (for catch-all generation)?
			else if (res.esm && config.generateIndex) {
				esmBuilds.push(res.esm);
			}

			// process each output format
			for (let format of [ "esm", "umd", ]) {
				if (res[format]) {
					let outputPath = path.join(config.to,format,res[format].pathStr);
					let outputDir = path.dirname(outputPath);
					if (!mkdir(outputDir)) {
						throw new Error(`Output directory (${ outputDir }) could not be created.`);
					}
					try {
						fs.writeFileSync(outputPath,res[format].code,"utf-8");
					}
					catch (err) {
						throw new Error(`Output file (${ outputPath }) could not be created.`);
					}
				}
			}
		}

		// generate the catch-all index for each build format
		if (config.generateIndex) {
			if (config.buildUMD) {
				let indexBuild = umdIndex(config,umdBuilds,knownDeps);
				umdBuilds.push(indexBuild);
				let outputPath = path.join(config.to,"umd",indexBuild.pathStr);
				try {
					fs.writeFileSync(outputPath,indexBuild.code,"utf-8");
				}
				catch (err) {
					throw new Error(`Generated index (${ outputPath }) could not be created.`);
				}
			}
			if (config.buildESM) {
				let indexBuild = esmIndex(config,esmBuilds,knownDeps);
				esmBuilds.push(indexBuild);
				let outputPath = path.join(config.to,"esm",indexBuild.pathStr);
				try {
					fs.writeFileSync(outputPath,indexBuild.code,"utf-8");
				}
				catch (err) {
					throw new Error(`Generated index (${ outputPath }) could not be created.`);
				}
			}
		}

		// need to bundle all the UMDs together?
		if (config.bundleUMDPath && umdBuilds.length > 0) {
			let res = bundleUMD(config,umdBuilds);
			try {
				fs.writeFileSync(config.bundleUMDPath,res.code,"utf-8");
			}
			catch (err) {
				throw new Error(`UMD bundle (${ config.bundleUMDPath }) could not be created.`);
			}
		}

		// copy any skipped files?
		if (config.copyFiles && config.copyFiles.length > 0) {
			for (let filePathStr of config.copyFiles) {
				let [ basePath, relativePath, ] = splitPath(config.from,filePathStr);
				let fromPathStr = path.join(basePath,relativePath);
				let contents = fs.readFileSync(fromPathStr);
				for (let format of [ "esm", "umd", ]) {
					if (
						(format == "esm" && config.buildESM) ||
						(format == "umd" && config.buildUMD)
					) {
						let toPathStr = path.resolve(path.join(config.to,format),relativePath);
						let toDir = path.dirname(toPathStr);

						if (!mkdir(toDir)) {
							throw new Error(`While copying skipped file (${ toPathStr }), directory (${ toDir }) could not be created.`);
						}
						fs.writeFileSync(toPathStr,contents);
					}
				}
			}
		}
	}
	catch (err) {
		return showError(err);
	}
}

function loadConfig() {
	var cfg;

	try {
		cfg = fs.readFileSync(RCPATH,"utf-8");
	}
	catch (err) {
		// no config found/available
		cfg = "";
	}

	try {
		cfg = JSON.parse(cfg);
	}
	catch (err) {
		// config was invalid
		if (!params.help) {
			return showError(`Invalid config: ${RCPATH}`,/*includeHelp=*/true);
		}
	}

	// merge in default configs for core and lib
	config = defaultLibConfig(defaultCLIConfig(cfg));

	return checkArgsAndConfig();
}

function checkArgsAndConfig() {
	// user asking for help output?
	if (params.help) {
		printHelp();
		return;
	}

	if (params.version) {
		printVersion();
		return;
	}

	// must build at least one format
	if (!(
		config.buildESM || config.buildUMD
	)) {
		return showError("Must select at least one output format (ESM or UMD).",/*includeHelp=*/true);
	}

	// from path invalid?
	if (!checkPath(config.from)) {
		return showError(`Input directory (${ config.from }) is missing or inaccessible.`);
	}
	// to path invalid?
	if (!checkPath(config.to)) {
		// should we create the default output target directory?
		if (/\.mz-build$/.test(config.to)) {
			// double-check the path was created?
			if (!mkdir(config.to)) {
				return showError(`Default output directory (${ config.to }) could not be created.`);
			}
		}
		else {
			return showError(`Output directory (${ config.to }) is missing or inaccessible.`);
		}

		if (config.buildESM) {
			let esmPath = path.join(config.to,"esm");
			if (!checkPath(esmPath)) {
				if (!mkdir(esmPath)) {
					return showError(`Output directory (${ esmPath }) could not be created.`);
				}
			}
		}
		if (config.buildUMD) {
			let umdPath = path.join(config.to,"umd");
			if (!checkPath(umdPath)) {
				if (!mkdir(umdPath)) {
					return showError(`Output directory (${ umdPath }) could not be created.`);
				}
			}
		}
	}

	// path specified to UMD dependency map?
	if (typeof config.depMap == "string") {
		// path is invalid?
		if (!checkPath(config.depMap)) {
			return showError(`Dependency map (${ config.depMap }) is missing or inaccessible.`);
		}

		// load UMD dependency map
		let json;
		try {
			json = JSON.parse(fs.readFileSync(config.depMap,"utf-8"));
			// need to find config in a package.json?
			if (/package\.json$/.test(config.depMap)) {
				json = json["mz-dependencies"];
				// "mz-config" key is missing or not an object?
				if (!json || typeof json != "object") {
					throw true;
				}
			}
		}
		catch (err) {
			return showError(`Invalid/missing dependency map (${ config.depMap }).`);
		}
		config.depMap = json;
	}
	else if (!("depMap" in config)) {
		if (config.buildUMD) {
			return showError("UMD build format requires dependency map.",/*includeHelp=*/true);
		}
	}

	return true;
}

function getInputFiles() {
	var files;

	// scan the directory for input files?
	if (isDirectory(config.from)) {
		if (config.recursive) {
			try {
				files = recursiveReadDir(config.from);
			}
			catch (err) {
				return showError(`Failed scanning for input files (${ config.from })`);
				return;
			}
		}
		else {
			files =
				fs.readdirSync(config.from)
				.filter(function skipDirs(pathStr){
					return !isDirectory(pathStr);
				})
		}
	}
	// otherwise, assume only a single input file
	else {
		files = [ config.from, ];
	}

	// any skip patterns to remove?
	if (Array.isArray(config.skip) && config.skip.length > 0) {
		files = files.filter(function skipFiles(pathStr){
			var res = micromatch(pathStr,config.skip).length == 0;
			if (
				// skipping file?
				!res &&
				// should copy it?
				config.copyOnSkip
			) {
				config.copyFiles = config.copyFiles || [];
				config.copyFiles.push(pathStr);
			}
			return res;
		});
	}

	// split all paths into base and relative
	files = files.map(function fixPaths(pathStr){
		var [ basePath, relativePath, ] = splitPath(config.from,pathStr);
		return [ basePath, addRelativeCurrentDir(relativePath), ];
	});

	return files;
}

function printHelp() {
	console.log("moduloze usage:");
	console.log("  mz {OPTIONS}");
	console.log("");
	console.log("--help                     print this help");
	console.log("--version                  print version info");
	console.log("--config={PATH}, -c        path to load config");
	console.log(`                           [${ RCPATH }]`);
	console.log("--from={PATH}              scan directory for input file(s)");
	console.log(`                           [${ config.from }]`);
	console.log("--to={PATH}                target directory for output file(s)");
	console.log(`                           [${ config.to }]`);
	console.log("--dep-map={PATH}, -m       dependency map file");
	console.log(`                           [${ config.depMap }]`);
	console.log("--recursive, -r            scan recursively for input files");
	console.log(`                           [${ config.recursive }]`);
	console.log("--build-esm, -e            build ES-Modules format from input file(s)");
	console.log(`                           [${ config.buildESM }]`);
	console.log("--build-umd, -u            build UMD format from input file(s)");
	console.log(`                           [${ config.buildUMD }]`);
	console.log("--bundle-umd={PATH}, -b    include UMD bundle");
	console.log(`                           [${ config.bundleUMDPath || "./umd/bundle.js" }]`);
	console.log("");
}

function printVersion() {
	console.log(`v${ programVersion }`);
}

function showError(err,includeHelp = false) {
	console.error(err.toString());
	if (includeHelp) {
		console.log("");
		printHelp();
	}
	process.exit(1);
}

function defaultCLIConfig({
	from = process.env.FROMPATH,
	to = process.env.TOPATH,
	depMap = process.env.DEPMAPPATH,
	bundleUMDPath,
	skip = [],
	copyOnSkip = false,
	copyFiles = [],
	recursive,
	buildESM,
	buildUMD,
	generateIndex = false,
	...other
} = {}) {
	// params override configs
	from = resolvePath(params.from || from || "./");
	to = resolvePath(params.to || to || "./.mz-build");
	depMap = (typeof depMap == "string" || typeof depMap == "undefined") ?
		resolvePath(params["dep-map"] || depMap || "./package.json") :
		depMap;
	bundleUMDPath =
		("bundle-umd" in params || bundleUMDPath || "UMDBUNDLEPATH" in process.env) ?
			resolvePath((params["bundle-umd"] || bundleUMDPath || process.env.UMDBUNDLEPATH || "./umd/bundle.js"),to) :
			false;
	recursive = params.recursive || recursive;
	buildESM = params["build-esm"] || buildESM;
	buildUMD = params["build-umd"] || buildUMD;

	return {
		from, to, recursive, buildESM, buildUMD, skip,
		copyOnSkip, copyFiles, depMap, bundleUMDPath,
		generateIndex, ...other,
	};
}

function resolvePath(pathStr,basePath = process.cwd()) {
	pathStr = expandHomeDir(pathStr);
	return path.resolve(basePath,pathStr);
}

function mkdir(pathStr) {
	try {
		mkdirp.sync(pathStr);
		return true;
	}
	catch (err) {
		return err;
	}
}
