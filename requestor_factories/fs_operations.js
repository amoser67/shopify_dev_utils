/* globals exports, require, __dirname */
"use strict";
const { exec } = require("child_process"); // Executes commands in the terminal.
const fs = require("fs");
const Path = require("path");
const process = require("process"); // Used to get the current platform.
const { run_async } = require("../utils");
const Chokidar = require("chokidar"); // Package for watching changes to files.
const sass = require("node-sass"); // SCSS compiler.
const { log } = require("../log");

const shopify_dev_utils_dir = Path.dirname(__dirname);
let jsmin_dir_path = Path.join(shopify_dev_utils_dir, "JSMin-master");
let jsmin_path = Path.join(jsmin_dir_path, "jsmin");
const platform = process.platform;
if (platform === "win32") {
    jsmin_path += ".exe";
} else if (
    platform === "darwin"
    && fs.existsSync(Path.join(jsmin_dir_path, "jsmin-darwin"))
) {
    jsmin_path = Path.join(jsmin_dir_path, "jsmin-darwin");
}


const get_all_file_paths = function (base_dir) {

//  Get all of the file (not directory) paths from a directory (called baseDirectory).
//  This is done in a breadth first manner, but continues until all files, regardless of depth,
//  are accounted for.

    const tmp_dirent_array = [];

// Each round of operations should consist of all dirs currently in here
// being read, the results saved, and then the dirs removed from here.

    const dirs_to_read = [base_dir];

    return function get_all_file_paths_requestor(cb, data) {
        try {

// Paths to all files in base directory will eventually be in here.

            data.files = [];

//  Initiates the recursive process which determines the path to all nested files.

            directory_reader();

            function directory_reader() {
                const total = dirs_to_read.length;
                let num = 0;
                while (num < total) {
                    const dir_path = dirs_to_read[num];
                    num += 1;
                    setTimeout(function () {
                        const options = { withFileTypes: true };
                        fs.readdir(
                            dir_path,
                            options,
                            function (err, dirents) {
                                if (err) throw err;
                                return dirent_organizer({
                                    dirName: dir_path,
                                    files: dirents
                                });
                            }
                        );
                    });
                }
            }

            function dirent_organizer(data) {
                tmp_dirent_array.push(data);
                if (tmp_dirent_array.length === dirs_to_read.length) {
                    while (dirs_to_read.length > 0) {
                        dirs_to_read.pop();
                    }
                    return dirent_handler();
                }
            }

            function dirent_handler() {
                tmp_dirent_array.forEach(function (dirent_obj, i) {
                    const path = dirent_obj.dirName;
                    const dirents = dirent_obj.files;
                    dirents.forEach(function (dirent) {
                        const dir_path = Path.join(path, dirent.name);
                        if (dirent.isDirectory()) {
                            dirs_to_read.push(dir_path);
                        } else {
                            data.files.push(dir_path);
                        }
                    });
                    if (i === tmp_dirent_array.length - 1) {
                        return check_if_done();
                    }
                });
            }

            function check_if_done() {
                while (tmp_dirent_array.length > 0) {
                    tmp_dirent_array.pop();
                }
                return (
                    dirs_to_read.length !== 0
                    ? directory_reader(dirent_organizer)
                    : cb(data)
                );
            }
        } catch (exception) {
            console.log(exception);
            return cb(null, exception);
        }
    };
};

const minify_js = function (input, output) {

//  @param1 {string|array} input  - The path(s) to the input file(s).
//  @param2 {string}       output  - The path to the output file.

    if (typeof input === "string" && input !== "from data") {
        return function minify_js_requestor(cb, data) {
            try {
                const command = jsmin_path + " <" + input + " >" + output;
                exec(command, function (err, stdout, stderr) {
                    if (err || stderr) {
                        return cb(null, err || stderr);
                    }
                    return cb(data);
                });
            } catch (exception) {
                return cb(null, exception);
            }
        };
    } else {
        return function minify_js_requestors(cb, data) {
            try {
                const filePaths = data.files;

                if (!Array.isArray(filePaths)) {
                    throw new TypeError("input is not of type array.");
                }

                const orderedFileContents = [];

                const requestors = filePaths.map(
                    function getModuleData(filePath, fileIndex) {
                        return function getModuleDataRequestor(cb) {
                            fs.readFile(filePath, "utf-8", function (err, text) {
                                if (err) return cb(null, err);
                                orderedFileContents[fileIndex] = text;
                                return cb();
                            });
                        };
                    }
                );

                run_async(
                    requestors,
                    function write_data(d, reason) {
                        if (d === null) return cb(null, reason);
                        if (d === undefined) {
                            d = data;
                        }
                        const write_path = Path.join(
                            Path.join(shopify_dev_utils_dir, "local-data"),
                            Path.parse(output).name.replace(".min", "")
                        );

                        // Write moduleText to ../local-data/moduleName
                        fs.writeFileSync(write_path, orderedFileContents.join("\n"));

                        // Use JSMin to minify the file text at ../local-data/moduleName,
                        // writing the output to theme/assets.
                        const command = `${jsmin_path} <${write_path} >${output}`;
                        exec(command, function minify(err, stdout, stderr) {
                            if (err || stderr) {
                                return cb(null, err || stderr);
                            }
                            fs.unlink(write_path, function (err) {
                                if (err) log("Error", err);
                            });
                            return cb(data);
                        });
                    },
                    data
                );
            } catch (exception) {
                return cb(null, exception);
            }
        };
    }
};

const process_scss = function (file_name, new_file_name=false) {
    return function process_scss_requestor(cb, data) {
        try {
            const options = {
                file: file_name,
                outputStyle: "compressed"
            };

            sass.render(options, (err, result) => {
                if (err) return cb(null, err);
                const css_buffer = result.css;
                const css_text = css_buffer.toString("utf-8");
                let final_result;

                function remove_surrounding_quotes_from_liquid_values(cb) {
                    const reg_a = /"\{\{/g;
                    const reg_b = /\}\}"/g;
                    final_result = css_text.replace(reg_a, "{{").replace(reg_b, "}}");
                    return cb();
                }

                function write_to_output() {
                    fs.writeFile(new_file_name, final_result, function (err) {
                        if (err) throw err;
                        return cb(data);
                    });
                }

                return remove_surrounding_quotes_from_liquid_values(write_to_output);
            });
        } catch (exception) {
            return cb(null, exception);
        }
    };
};


const read_file = function (path, enc="utf8") {
    return function read_file_requestor(cb, data) {
        try {
            fs.readFile(path, enc, function addContentToData(err, fileContent) {
                if (err) return cb(null, err);
                data.file_content = fileContent;
                return cb(data);
            });
        } catch (exception) {
            return cb(null, exception);
        }
    };
};


const start_watchers = function (handler) {

//  @param1 {string} type - One of "theme", "scripts", or "styles".
//  @param2 {function} handler - The function to be called when an even is triggered.

    return function start_watchers_requestor(cb, data) {
        try {
            const options = { ignoreInitial: true };
            Chokidar.watch(data.paths.scripts, options).on("all", handler("scripts"));
            Chokidar.watch(data.paths.styles, options).on("all", handler("styles"));
            Chokidar.watch(data.paths.theme, options).on("all", handler("theme"));
            return cb(data);
        } catch (exception) {
            return cb(null, exception);
        }
    };
};


const unlink_file = function (file_path) {
    return function unlink_file_requestor(cb, data) {
        try {
            fs.unlink(file_path, function (err) {
                if (err) log("Error", err);
                return cb(data);
            });
        } catch (exception) {
            return cb(null, exception);
        }
    };
};


const write_file = function (path, file_content=false) {
    return function read_file_requestor(cb, data) {
        try {
            const content = file_content ? file_content : data.file_content;
            fs.writeFile(path, content, function (err) {
                if (err) throw err;
                return cb(data);
            });
        } catch (exception) {
            return cb(null, exception);
        }
    };
};


exports.get_all_file_paths = get_all_file_paths;
exports.minify_js = minify_js;
exports.process_scss = process_scss;
exports.read_file = read_file;
exports.start_watchers = start_watchers;
exports.unlink_file = unlink_file;
exports.write_file = write_file;
