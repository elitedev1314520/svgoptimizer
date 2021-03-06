/* jshint quotmark: false */
"use strict";

var FS = require("fs"),
    PATH = require("path"),
    chalk = require("chalk"),
    mkdirp = require("mkdirp"),
    promisify = require("util.promisify"),
    readdir = promisify(FS.readdir),
    readFile = promisify(FS.readFile),
    writeFile = promisify(FS.writeFile),
    OPTSVG = require("../optsvg.js"),
    YAML = require("js-yaml"),
    PKG = require("../../package.json"),
    encodeSVGDatauri = require("./tools.js").encodeSVGDatauri,
    decodeSVGDatauri = require("./tools.js").decodeSVGDatauri,
    checkIsDir = require("./tools.js").checkIsDir,
    regSVGFile = /\.svg$/,
    noop = () => {},
    optsvgs;

module.exports = require("coa")
    .Cmd()
    .helpful()
    .name(PKG.name)
    .title(PKG.description)
    .opt()
    .name("version")
    .title("Version")
    .short("v")
    .long("version")
    .only()
    .flag()
    .act(function () {
        // output the version to stdout instead of stderr if returned
        process.stdout.write(PKG.version + "\n");
        // coa will run `.toString` on the returned value and send it to stderr
        return "";
    })
    .end()
    .opt()
    .name("input")
    .title('Input file, "-" for STDIN')
    .short("i")
    .long("input")
    .arr()
    .val(function (val) {
        return val || this.reject("Option '--input' must have a value.");
    })
    .end()
    .opt()
    .name("string")
    .title("Input SVG data string")
    .short("s")
    .long("string")
    .end()
    .opt()
    .name("folder")
    .title("Input folder, optimize and rewrite all *.svg files")
    .short("f")
    .long("folder")
    .val(function (val) {
        return val || this.reject("Option '--folder' must have a value.");
    })
    .end()
    .opt()
    .name("output")
    .title(
        'Output file or folder (by default the same as the input), "-" for STDOUT'
    )
    .short("o")
    .long("output")
    .arr()
    .val(function (val) {
        return val || this.reject("Option '--output' must have a value.");
    })
    .end()
    .opt()
    .name("precision")
    .title(
        "Set number of digits in the fractional part, overrides plugins params"
    )
    .short("p")
    .long("precision")
    .val(function (val) {
        return !isNaN(val)
            ? val
            : this.reject("Option '--precision' must be an integer number");
    })
    .end()
    .opt()
    .name("config")
    .title("Config file or JSON string to extend or replace default")
    .long("config")
    .val(function (val) {
        return val || this.reject("Option '--config' must have a value.");
    })
    .end()
    .opt()
    .name("disable")
    .title(
        'Disable plugin by name, "--disable={PLUGIN1,PLUGIN2}" for multiple plugins (*nix)'
    )
    .long("disable")
    .arr()
    .val(function (val) {
        return val || this.reject("Option '--disable' must have a value.");
    })
    .end()
    .opt()
    .name("enable")
    .title(
        'Enable plugin by name, "--enable={PLUGIN3,PLUGIN4}" for multiple plugins (*nix)'
    )
    .long("enable")
    .arr()
    .val(function (val) {
        return val || this.reject("Option '--enable' must have a value.");
    })
    .end()
    .opt()
    .name("datauri")
    .title("Output as Data URI string (base64, URI encoded or unencoded)")
    .long("datauri")
    .val(function (val) {
        return (
            val ||
            this.reject(
                "Option '--datauri' must have one of the following values: 'base64', 'enc' or 'unenc'"
            )
        );
    })
    .end()
    .opt()
    .name("multipass")
    .title(
        "Pass over SVGs multiple times to ensure all optimizations are applied"
    )
    .long("multipass")
    .flag()
    .end()
    .opt()
    .name("pretty")
    .title("Make SVG pretty printed")
    .long("pretty")
    .flag()
    .end()
    .opt()
    .name("indent")
    .title("Indent number when pretty printing SVGs")
    .long("indent")
    .val(function (val) {
        return !isNaN(val)
            ? val
            : this.reject("Option '--indent' must be an integer number");
    })
    .end()
    .opt()
    .name("recursive")
    .title("Use with '-f'. Optimizes *.svg files in folders recursively.")
    .short("r")
    .long("recursive")
    .flag()
    .end()
    .opt()
    .name("quiet")
    .title("Only output error messages, not regular status messages")
    .short("q")
    .long("quiet")
    .flag()
    .end()
    .opt()
    .name("show-plugins")
    .title("Show available plugins and exit")
    .long("show-plugins")
    .flag()
    .end()
    .arg()
    .name("input")
    .title("Alias to --input")
    .arr()
    .end()
    .act(function (opts, args) {
        var input = opts.input || args.input,
            output = opts.output,
            config = {};

        // --show-plugins
        if (opts["show-plugins"]) {
            showAvailablePlugins();
            return;
        }

        // w/o anything
        if (
            (!input || input[0] === "-") &&
            !opts.string &&
            !opts.stdin &&
            !opts.folder &&
            process.stdin.isTTY === true
        )
            return this.usage();

        if (
            typeof process == "object" &&
            process.versions &&
            process.versions.node &&
            PKG &&
            PKG.engines.node
        ) {
            var nodeVersion = String(PKG.engines.node).match(/\d*(\.\d+)*/)[0];
            if (parseFloat(process.versions.node) < parseFloat(nodeVersion)) {
                return printErrorAndExit(
                    `Error: ${PKG.name} requires Node.js version ${nodeVersion} or higher.`
                );
            }
        }

        // --config
        if (opts.config) {
            // string
            if (opts.config.charAt(0) === "{") {
                try {
                    config = JSON.parse(opts.config);
                } catch (e) {
                    return printErrorAndExit(
                        `Error: Couldn't parse config JSON.\n${String(e)}`
                    );
                }
                // external file
            } else {
                var configPath = PATH.resolve(opts.config),
                    configData;
                try {
                    // require() adds some weird output on YML files
                    configData = FS.readFileSync(configPath, "utf8");
                    config = JSON.parse(configData);
                } catch (err) {
                    if (err.code === "ENOENT") {
                        return printErrorAndExit(
                            `Error: couldn't find config file '${opts.config}'.`
                        );
                    } else if (err.code === "EISDIR") {
                        return printErrorAndExit(
                            `Error: directory '${opts.config}' is not a config file.`
                        );
                    }
                    config = YAML.safeLoad(configData);
                    config.__DIR = PATH.dirname(configPath); // will use it to resolve custom plugins defined via path

                    if (!config || Array.isArray(config)) {
                        return printErrorAndExit(
                            `Error: invalid config file '${opts.config}'.`
                        );
                    }
                }
            }
        }

        // --quiet
        if (opts.quiet) {
            config.quiet = opts.quiet;
        }

        // --recursive
        if (opts.recursive) {
            config.recursive = opts.recursive;
        }

        // --precision
        if (opts.precision) {
            var precision = Math.min(Math.max(0, parseInt(opts.precision)), 20);
            if (!isNaN(precision)) {
                config.floatPrecision = precision;
            }
        }

        // --disable
        if (opts.disable) {
            changePluginsState(opts.disable, false, config);
        }

        // --enable
        if (opts.enable) {
            changePluginsState(opts.enable, true, config);
        }

        // --multipass
        if (opts.multipass) {
            config.multipass = true;
        }

        // --pretty
        if (opts.pretty) {
            config.js2svg = config.js2svg || {};
            config.js2svg.pretty = true;
            var indent;
            if (opts.indent && !isNaN((indent = parseInt(opts.indent)))) {
                config.js2svg.indent = indent;
            }
        }

        optsvg = new OPTSVG(config);

        // --output
        if (output) {
            if (input && input[0] != "-") {
                if (output.length == 1 && checkIsDir(output[0])) {
                    var dir = output[0];
                    for (var i = 0; i < input.length; i++) {
                        output[i] = checkIsDir(input[i])
                            ? input[i]
                            : PATH.resolve(dir, PATH.basename(input[i]));
                    }
                } else if (output.length < input.length) {
                    output = output.concat(input.slice(output.length));
                }
            }
        } else if (input) {
            output = input;
        } else if (opts.string) {
            output = "-";
        }

        if (opts.datauri) {
            config.datauri = opts.datauri;
        }

        // --folder
        if (opts.folder) {
            var ouputFolder = (output && output[0]) || opts.folder;
            return optimizeFolder(config, opts.folder, ouputFolder).then(
                noop,
                printErrorAndExit
            );
        }

        // --input
        if (input) {
            // STDIN
            if (input[0] === "-") {
                return new Promise((resolve, reject) => {
                    var data = "",
                        file = output[0];

                    process.stdin
                        .on("data", (chunk) => (data += chunk))
                        .once("end", () =>
                            processSVGData(
                                config,
                                { input: "string" },
                                data,
                                file
                            ).then(resolve, reject)
                        );
                });
                // file
            } else {
                return Promise.all(
                    input.map((file, n) =>
                        optimizeFile(config, file, output[n])
                    )
                ).then(noop, printErrorAndExit);
            }

            // --string
        } else if (opts.string) {
            var data = decodeSVGDatauri(opts.string);

            return processSVGData(config, { input: "string" }, data, output[0]);
        }
    });

function changePluginsState(names, state, config) {
    names.forEach(flattenPluginsCbk);

    // extend config
    if (config.plugins) {
        for (var name of names) {
            var matched = false,
                key;

            for (var plugin of config.plugins) {
                // get plugin name
                if (typeof plugin === "object") {
                    key = Object.keys(plugin)[0];
                } else {
                    key = plugin;
                }

                // if there is such a plugin name
                if (key === name) {
                    // don't replace plugin's params with true
                    if (typeof plugin[key] !== "object" || !state) {
                        plugin[key] = state;
                    }
                    // mark it as matched
                    matched = true;
                }
            }

            // if not matched and current config is not full
            if (!matched && !config.full) {
                // push new plugin Object
                config.plugins.push({ [name]: state });
                matched = true;
            }
        }
        // just push
    } else {
        config.plugins = names.map((name) => ({ [name]: state }));
    }
    return config;
}

function flattenPluginsCbk(name, index, names) {
    var split = name.split(",");

    if (split.length > 1) {
        names[index] = split.shift();
        names.push.apply(names, split);
    }
}

function optimizeFolder(config, dir, output) {
    if (!config.quiet) {
        console.log(`Processing directory '${dir}':\n`);
    }
    return readdir(dir).then((files) =>
        processDirectory(config, dir, files, output)
    );
}

function processDirectory(config, dir, files, output) {
    // take only *.svg files, recursively if necessary
    var svgFilesDescriptions = getFilesDescriptions(config, dir, files, output);

    return svgFilesDescriptions.length
        ? Promise.all(
              svgFilesDescriptions.map((fileDescription) =>
                  optimizeFile(
                      config,
                      fileDescription.inputPath,
                      fileDescription.outputPath
                  )
              )
          )
        : Promise.reject(
              new Error(`No SVG files have been found in '${dir}' directory.`)
          );
}

function getFilesDescriptions(config, dir, files, output) {
    const filesInThisFolder = files
        .filter((name) => regSVGFile.test(name))
        .map((name) => ({
            inputPath: PATH.resolve(dir, name),
            outputPath: PATH.resolve(output, name),
        }));

    return config.recursive
        ? [].concat(
              filesInThisFolder,
              files
                  .filter((name) => checkIsDir(PATH.resolve(dir, name)))
                  .map((subFolderName) => {
                      const subFolderPath = PATH.resolve(dir, subFolderName);
                      const subFolderFiles = FS.readdirSync(subFolderPath);
                      const subFolderOutput = PATH.resolve(
                          output,
                          subFolderName
                      );
                      return getFilesDescriptions(
                          config,
                          subFolderPath,
                          subFolderFiles,
                          subFolderOutput
                      );
                  })
                  .reduce((a, b) => [].concat(a, b), [])
          )
        : filesInThisFolder;
}

function optimizeFile(config, file, output) {
    return readFile(file, "utf8").then(
        (data) =>
            processSVGData(
                config,
                { input: "file", path: file },
                data,
                output,
                file
            ),
        (error) => checkOptimizeFileError(config, file, output, error)
    );
}

function processSVGData(config, info, data, output, input) {
    var startTime = Date.now(),
        prevFileSize = Buffer.byteLength(data, "utf8");

    return optsvg.optimize(data, info).then(function (result) {
        if (config.datauri) {
            result.data = encodeSVGDatauri(result.data, config.datauri);
        }
        var resultFileSize = Buffer.byteLength(result.data, "utf8"),
            processingTime = Date.now() - startTime;

        return writeOutput(input, output, result.data).then(
            function () {
                if (!config.quiet && output != "-") {
                    if (input) {
                        console.log(`\n${PATH.basename(input)}:`);
                    }
                    printTimeInfo(processingTime);
                    printProfitInfo(prevFileSize, resultFileSize);
                }
            },
            (error) =>
                Promise.reject(
                    new Error(
                        error.code === "ENOTDIR"
                            ? `Error: output '${output}' is not a directory.`
                            : error
                    )
                )
        );
    });
}

function writeOutput(input, output, data) {
    if (output == "-") {
        console.log(data);
        return Promise.resolve();
    }

    mkdirp.sync(PATH.dirname(output));

    return writeFile(output, data, "utf8").catch((error) =>
        checkWriteFileError(input, output, data, error)
    );
}

function printTimeInfo(time) {
    console.log(`Done in ${time} ms!`);
}

function printProfitInfo(inBytes, outBytes) {
    var profitPercents = 100 - (outBytes * 100) / inBytes;

    console.log(
        Math.round((inBytes / 1024) * 1000) / 1000 +
            " KiB" +
            (profitPercents < 0 ? " + " : " - ") +
            chalk.green(Math.abs(Math.round(profitPercents * 10) / 10) + "%") +
            " = " +
            Math.round((outBytes / 1024) * 1000) / 1000 +
            " KiB"
    );
}

function checkOptimizeFileError(config, input, output, error) {
    if (error.code == "EISDIR") {
        return optimizeFolder(config, input, output);
    } else if (error.code == "ENOENT") {
        return Promise.reject(
            new Error(`Error: no such file or directory '${error.path}'.`)
        );
    }
    return Promise.reject(error);
}

function checkWriteFileError(input, output, data, error) {
    if (error.code == "EISDIR" && input) {
        return writeFile(
            PATH.resolve(output, PATH.basename(input)),
            data,
            "utf8"
        );
    } else {
        return Promise.reject(error);
    }
}

/**
 * Show list of available plugins with short description.
 */
function showAvailablePlugins() {
    console.log("Currently available plugins:");

    // Flatten an array of plugins grouped per type, sort and write output
    var list = [].concat
        .apply([], new OPTSVG().config.plugins)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
            (plugin) => ` [ ${chalk.green(plugin.name)} ] ${plugin.description}`
        )
        .join("\n");
    console.log(list);
}

function printErrorAndExit(error) {
    console.error(chalk.red(error));
    process.exit(1);
    return Promise.reject(error); // for tests
}
