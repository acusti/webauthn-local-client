#!/usr/bin/env node

"use strict";

var path = require("path");
var fs = require("fs");
var fsp = require("fs/promises");

var micromatch = require("micromatch");
var recursiveReadDir = require("recursive-readdir-sync");
var terser = require("terser");

const PKG_ROOT_DIR = path.join(__dirname,"..");
const SRC_DIR = path.join(PKG_ROOT_DIR,"src");
const MAIN_COPYRIGHT_HEADER = path.join(SRC_DIR,"copyright-header.txt");
const BUNDLERS_IMPORTS = path.join(SRC_DIR,"bundlers-imports.txt");
const NODE_MODULES_DIR = path.join(PKG_ROOT_DIR,"node_modules");
const ASN1_SRC = path.join(NODE_MODULES_DIR,"@yoursunny","asn1","dist","asn1.all.min.js");
const ASN1_COPYRIGHT_HEADER = path.join(__dirname,"asn1-copyright-header.txt");
const CBOR_SRC = path.join(NODE_MODULES_DIR,"cbor-js","cbor.js");
const LIBSODIUM_SRC = path.join(NODE_MODULES_DIR,"libsodium","dist","modules","libsodium.js");
const LIBSODIUM_WRAPPERS_SRC = path.join(NODE_MODULES_DIR,"libsodium-wrappers","dist","modules","libsodium-wrappers.js");

const DIST_DIR = path.join(PKG_ROOT_DIR,"dist");
const DIST_AUTO_DIR = path.join(DIST_DIR,"auto");
const DIST_BUNDLERS_DIR = path.join(DIST_DIR,"bundlers");
const DIST_AUTO_WALC_FILE = path.join(DIST_AUTO_DIR,"walc.js");
const DIST_AUTO_EXTERNAL_DIR = path.join(DIST_AUTO_DIR,"external");
const DIST_AUTO_EXTERNAL_ASN1 = path.join(DIST_AUTO_EXTERNAL_DIR,path.basename(ASN1_SRC));
const DIST_AUTO_EXTERNAL_CBOR = path.join(DIST_AUTO_EXTERNAL_DIR,path.basename(CBOR_SRC));
const DIST_AUTO_EXTERNAL_LIBSODIUM = path.join(DIST_AUTO_EXTERNAL_DIR,path.basename(LIBSODIUM_SRC));
const DIST_AUTO_EXTERNAL_LIBSODIUM_WRAPPERS = path.join(DIST_AUTO_EXTERNAL_DIR,path.basename(LIBSODIUM_WRAPPERS_SRC));

const DIST_BUNDLERS_WALC_FILE = path.join(DIST_BUNDLERS_DIR,path.basename(DIST_AUTO_WALC_FILE));
const DIST_BUNDLERS_WALC_EXTERNAL_BUNDLE_FILE = path.join(DIST_BUNDLERS_DIR,"walc-external-bundle.js");


main().catch(console.error);


// **********************

async function main() {
	console.log("*** Building JS ***");

	// try to make various dist/ directories, if needed
	for (let dir of [ DIST_DIR, DIST_AUTO_DIR, DIST_BUNDLERS_DIR, DIST_AUTO_EXTERNAL_DIR, ]) {
		if (!(await safeMkdir(dir))) {
			throw new Error(`Target directory (${dir}) does not exist and could not be created.`);
		}
	}

	// read package.json
	var packageJSON = require(path.join(PKG_ROOT_DIR,"package.json"));
	// read version number from package.json
	var version = packageJSON.version;
	var [ mainCopyrightHeader, asn1CopyrightHeader, ] = await Promise.all([
		// read main src copyright-header text,
		fsp.readFile(MAIN_COPYRIGHT_HEADER,{ encoding: "utf8", }),

		// read ASN1 copyright header (required by MPL2 license)
		fsp.readFile(ASN1_COPYRIGHT_HEADER,{ encoding: "utf8", }),
	]);
	// render main copyright header with version and year
	mainCopyrightHeader = (
		mainCopyrightHeader
			.replace(/#VERSION#/g,version)
			.replace(/#YEAR#/g,(new Date()).getFullYear())
	);

	// build src/* files in dist/auto/
	await buildFiles(
		recursiveReadDir(SRC_DIR),
		SRC_DIR,
		DIST_AUTO_DIR,
		mainCopyrightHeader,
		/*skipPatterns=*/[ "**/*.txt", "**/*.json", "**/external" ]
	);

	var [
		walcLibContents,
		asn1Contents,
		cborContents,
		libsodiumContents,
		libsodiumWrappersContents,
	] = await Promise.all([
		fsp.readFile(DIST_AUTO_WALC_FILE,{ encoding: "utf8", }),
		fsp.readFile(ASN1_SRC,{ encoding: "utf8", }),
		fsp.readFile(CBOR_SRC,{ encoding: "utf8", }),
		fsp.readFile(LIBSODIUM_SRC,{ encoding: "utf8", }),
		fsp.readFile(LIBSODIUM_WRAPPERS_SRC,{ encoding: "utf8", }),
	]);

	// prepare bundler.index.js
	walcLibContents = (
		walcLibContents
			// update the filename in the copyright header
			.replace(/(WebAuthn-Local-Client: )(walc\.js)/,"$1bundlers/$2")

			// remove reference to importing the "external.js" module
			// since bundlers handle the dependencies
			.replace(/import ?".\/external.js";?/,"")
	);

	// prepend MPL2-required copyright header
	asn1Contents = `${asn1CopyrightHeader}${asn1Contents}`;

	// build walc-external-bundle.js
	var walcExternalBundleContents = [
		`/*! ${path.basename(ASN1_SRC)} */`, asn1Contents.trim(),
		`/*! ${path.basename(CBOR_SRC)} */`, await minifyJS(cborContents),
		`/*! ${path.basename(LIBSODIUM_SRC)} */`, libsodiumContents.trim(),
		`/*! ${path.basename(LIBSODIUM_WRAPPERS_SRC)} */`, libsodiumWrappersContents.trim(),
	].join("\n");

	await Promise.all([
		// bundlers/walc.js (for bundlers)
		fsp.writeFile(
			DIST_BUNDLERS_WALC_FILE,
			walcLibContents,
			{ encoding: "utf8", }
		),
		// bundlers/walc-external-bundle.js (for bundlers)
		fsp.writeFile(
			DIST_BUNDLERS_WALC_EXTERNAL_BUNDLE_FILE,
			walcExternalBundleContents,
			{ encoding: "utf8", }
		),
		// add ASN1's license-required copyright header
		fsp.writeFile(
			DIST_AUTO_EXTERNAL_ASN1,
			asn1Contents,
			{ encoding: "utf8", }
		),
		fsp.writeFile(
			DIST_AUTO_EXTERNAL_CBOR,
			cborContents,
			{ encoding: "utf8", }
		),
		fsp.writeFile(
			DIST_AUTO_EXTERNAL_LIBSODIUM,
			libsodiumContents,
			{ encoding: "utf8", }
		),
		fsp.writeFile(
			DIST_AUTO_EXTERNAL_LIBSODIUM_WRAPPERS,
			libsodiumWrappersContents,
			{ encoding: "utf8", }
		),
	]);

	console.log("Complete.");
}

async function buildFiles(files,fromBasePath,toDir,copyrightHeader,skipPatterns) {
	for (let fromPath of files) {
		// should we skip copying this file?
		if (matchesSkipPattern(fromPath,skipPatterns)) {
			continue;
		}
		let relativePath = fromPath.slice(fromBasePath.length);
		let outputPath = path.join(toDir,relativePath);
		let outputDir = path.dirname(outputPath);

		if (!(fs.existsSync(outputDir))) {
			if (!(await safeMkdir(outputDir))) {
				throw new Error(`While copying src/* to dist/, directory (${outputDir}) could not be created.`);
			}
		}

		let contents = await fsp.readFile(fromPath,{ encoding: "utf8", });

		// JS file (to minify)?
		if (/\.[mc]?js$/i.test(relativePath)) {
			contents = await minifyJS(contents);
		}

		await fsp.writeFile(
			outputPath,
			`${
				copyrightHeader.replace(/#FILENAME#/g,path.basename(outputPath))
			}\n${
				contents
			}`,
			{ encoding: "utf8", }
		);
	}
}

async function minifyJS(contents) {
	let result = await terser.minify(contents,{
		mangle: {
			keep_fnames: true,
		},
		compress: {
			keep_fnames: true,
		},
		output: {
			comments: /^!/,
		},
		module: true,
	});
	if (!(result && result.code)) {
		if (result.error) throw result.error;
		else throw result;
	}
	return result.code;
}

function matchesSkipPattern(pathStr,skipPatterns) {
	if (skipPatterns && skipPatterns.length > 0) {
		return (micromatch(pathStr,skipPatterns).length > 0);
	}
}

async function safeMkdir(pathStr) {
	if (!fs.existsSync(pathStr)) {
		try {
			await fsp.mkdir(pathStr,0o755);
			return true;
		}
		catch (err) {}
		return false;
	}
	return true;
}
