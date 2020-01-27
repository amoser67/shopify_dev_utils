"use strict";
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { run_sync, run_async } = require("../utils");
const chokidar = require("chokidar");
const sass = require("node-sass");
const ShopifyAPI = require("./api_requests.js");
const { log } = require("../log");
const requestor_factories_dir = __dirname;
const shopify_dev_utils_dir = path.dirname(__dirname);
const jsmin_dir = shopify_dev_utils_dir + "/JSMin-master";


//  Module Public Methods:
//  get_all_file_paths()
//  minify_js()
//  process_scss()
//  read_file()
//  start_watchers()
//  unlink_file()
//  write_file()


//  Get all of the file (not directory) paths from a directory (called baseDirectory).
//  This is done in a breadth first manner, but continues until all files, regardless of depth,
//  are accounted for.
const get_all_file_paths = function (base_dir) {
// After a round of parallelesque operations on the dirs_to_read.
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
                        const dir_path = path + '/' + dirent.name;
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
            return cb(null, exception);
        }
    }
}


//  Minify JS Procedure:
//
//  1.  Takes a JS file path or an array of JS file paths, called input.
//  2a.  If input is a string:
//           i.    Extract JS.
//           ii.   Minify the extracted JS.
//           iii.  Write the minified JS to output.
//           iv.   Call next function.
//  2b.  If input is an array, run the following sequence asynchronously for all file paths:
//          i.    Extract JS.
//          ii.   Minify the extracted JS.
//          iii.  Push minified JS to min_js_array.
//          iv.   If all other files have been processed, join min_js_array, write
//                the resulting string to output, and call the next function, otherwise
//                do nothing.
//
//  @param1 {string|array} input  - The path(s) to the input file(s).
//  @param2 {string}       output  - The path to the output file.
const minify_js = function (input, output) {
    const input_is_string = (typeof input === "string");
    const options = { cwd: jsmin_dir };

    if (input_is_string) {
        return function minify_js_requestor(cb, data) {
            try {
                execFile(
                    "jsmin",
                    [ input ],
                    options,
                    function write_to_output(error, stdout) {
                        if (error) return cb(null, error);
                        fs.writeFile(output, stdout, function (err) {
                            if (err) return cb(null, err);
                            return cb(data);
                        });
                    }
                );
            } catch (exception) {
                return cb(null, exception);
            }
        }
    } else {
        return function minify_js_requestors(cb, data) {
            try {
                const min_js_array = [];
                const max = input.length;
                const requestors = input.map(file => minify_file(file));
                function minify_file(file) {
                    return function minify_file_requestor(cb, data) {
                        try {
                            execFile(
                                "jsmin",
                                [ file ],
                                options,
                                function push_to_min_js(error, stdout) {
                                    if (error) return cb(null, error);
                                    min_js_array.push(stdout);
                                    return cb(data)
                                }
                            );
                        } catch (exception) {
                            return cb(null, exception);
                        }
                    }
                }
                run_async(
                    requestors,
                    function (data, reason) {
                        if (data === null) throw reason;
                        const min_js = min_js_array.join("");
                        fs.writeFile(output, min_js, function (err) {
                            if (err) return cb(null, err);
                            return cb(data);
                        });
                    },
                    Object.create(null)
                );
            } catch (exception) {
                return cb(null, exception);
            }
        }
    }
}


const process_scss = function (file_name, new_file_name=false, paths) {
    return function process_scss_requestor(cb, data) {
        try {
            const options = {
                file: file_name,
                outputStyle: "compressed"
            };
            sass.render(
                options,
                function write_to_output(err, result) {
                    if (err) return cb(null, err);
                    fs.writeFile(
                        new_file_name,
                        result.css.toString("utf-8"),
                        function (err) {
                            if (err) return cb(null, err);
                            return cb(data);
                        }
                    );
                }
            );
        } catch (exception) {
            return cb(null, exception);
        }
    }
}


const read_file = function (path, enc="utf8") {
    return function read_file_requestor(cb, data) {
        try {
            fs.readFile(
                path,
                enc,
                function add_content_to_data(err, file_content) {
                    if (err) return cb(null, err);
                    data.file_content = file_content;
                    return cb(data);
                }
            );
        } catch (exception) {
            return cb(null, exception);
        }
    }
};


//  @param1 {string} type - One of "theme", "scripts", or "styles".
//  @param2 {function} handler - The function to be called when an even is triggered.
const start_watchers = function (handler) {
    return function start_watchers_requestor(cb, data) {
        try {
            const options = { ignoreInitial: true };
            chokidar.watch(
                data.paths.scripts,
                options
            ).on("all", handler("scripts"));

            chokidar.watch(
                data.paths.styles,
                options
            ).on("all", handler("styles"));

            chokidar.watch(
                data.paths.theme,
                options
            ).on("all", handler("theme"));

            return cb(data);
        } catch (exception) {
            return cb(null, exception);
        }
    }
}


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
    }
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
    }
};


exports.get_all_file_paths = get_all_file_paths;
exports.minify_js = minify_js;
exports.process_scss = process_scss;
exports.read_file = read_file;
exports.start_watchers = start_watchers;
exports.unlink_file = unlink_file;
exports.write_file = write_file;
