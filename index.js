"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");
const WebSocket = require("ws");
const Fs = require("./requestor_factories/fs_operations");
const ShopifyAPI = require("./requestor_factories/api_requests");
const Utils = require("./utils");
const { run_sync, run_async } = Utils;
const { log } = require("./log");
const { create_data_object, data_objects_init } = require("./create_data_objects");
//  Any binary encoded files must be processed and uploaded differently than text
//  files. This list is by no means exhaustive, but serves to list all of the binary
//  file types which may be present in the theme/assets directory.
//  Feel free to add additional types as necessary.
const non_string_formats = [
    ".woff",
    ".woff2",
    ".png",
    ".jpg",
    ".eot",
    ".ttf",
    ".gif"
];
const theme_dirs = [
    "snippets",  //  Can contain files or dirs, if a dir, its files are joined and then uploaded as dirname.liquid.
    "sections",  //  ""
    "templates/customers",
    "templates",
    "layout",
    "locales",
    "assets"
];
let server;
let wss;
let websocket;
let browser_url = `http://localhost`;
let store_url;
let store_preview_url;
let theme_id;
let auth;
let port;
const paths = Object.create(null);
// init_local_server
// create_websocket
// Fs.start_watchers(update_theme, paths)
const start = function run_app(env_vars) {
    try {
        store_url = env_vars.store_url;
        store_preview_url = env_vars.store_preview_url;
        theme_id = env_vars.theme_id;
        auth = env_vars.auth;
        paths.base = env_vars.base_path;
        paths.scripts = `${paths.base}/scripts`;
        paths.styles = `${paths.base}/styles`;
        paths.theme = `${paths.base}/theme`;
        port = env_vars.port;
        const data = Object.create(null);
        data.paths = paths;
        run_sync(
            [
                data_objects_init(env_vars),
                init_local_server(),
                create_websocket(),
                Fs.start_watchers(update_theme),
                Utils.open(`${browser_url}:${port}`)
            ],
            function (data, reason) {
                if (data === null) throw reason;
                log("Application", "ready");
            },
            data
        );
    } catch (exception) {
        log("Error", "start" + exception);
    }
};

exports.start = start;



function init_local_server() {
    return function init_server_requestor(cb, data) {
        try {
            server = http.createServer();
            server.listen(port);
//  Handle requests to our local server.
//  1.  Request the store's HTML content.
//  2.  Get the text for the client side JS script.
//  3.  Append the script from #2 to the end of the body of the HTML from #1.
//  4.  Send the result of #3 to the client as a response to this request.
            server.on("request", server_request_handler);

            function server_request_handler(request, response) {
                const ws_script_path = `${paths.base}/node_modules/shopify_dev_utils/websocket_insert_script.txt`;
                run_sync(
                    [
                        ShopifyAPI.get_shopify_page_html(request.url),
                        Fs.read_file(ws_script_path)
                    ],
                    function (data, reason) {
                        if (data === null) throw reason;
                        const html_file = `${paths.base}/node_modules/shopify_dev_utils/store_page_content.html`;
                        fs.open(html_file, "r", function (err, fd) {
                            if (err) {
                                if (err.code === 'ENOENT') {
                                    log("Error", "ENOENT: HTML file does not exist")
                                    return;
                                }
                                throw err;
                            }
                            fs.readFile(fd, "utf-8", function (err, content) {
                                if (err) throw err;
                                response.writeHead(200, { "Content-Type": "text/html" });
                                response.write(
                                    content.replace("</body>", data.file_content + "\n</body>")
                                );
                                response.end();
                            });
                        });
                    },
                    create_data_object("auth", "paths")
                );
            }
            return cb(data);
        } catch (exception) {
            return cb(null, exception);
        }
    }
}


//  Create a local websocket server.
//  This enables the client to create a browser websocket to connect with our local
//  server, enabling client - server two way communication.
function create_websocket() {
    return function create_websocket_requestor(cb, data) {
        try {
            wss = new WebSocket.Server({ server });
            wss.on("connection", function (ws) {
                ws.send("WebSocket connection established.");
                websocket = ws;
            });
            return cb(data);
        } catch (exception) {
            return cb(null, "create_websocket" + exception);
        }
    }
}



function update_theme(type) {
//  When a directory is added to scripts, if we dont handle it properly, then
//  the addDir and add events for contained files will all fire near the same time.
//  So here we make sure that for addDir or add events, only one can occur each second.
//  Additionally, any events heard during the 1 second timeout are forgotten.
    if (type === "scripts") {
        let count = 0;
        return function update_scripts_requestor(event, file_path) {
            try {
                if (event === "addDir" || event === "add") {
                    count += 1;
                    setTimeout(
                        function reduce_count() {
                            count -=1;
                        },
                        1000
                    );
                }
                if (event === "addDir" || event === "unlinkDir") {
                    const dir_name = path.parse(file_path).base;
                    const min_base = `${dir_name}.min.js`;
                    const key = `assets/${min_base}`;
                    const min_local_path = `${paths.theme}/${key}`;
                    if (event === "addDir") {
                        if (count > 1) return;
                        run_sync(
                            [
                                Fs.get_all_file_paths(file_path),
                                process_js("from data", key)
                            ],
                            function (data, reason) {
                                if (data === null) throw reason;
                                log("Uploaded", key);
                                websocket.terminate();
                            },
                            Object.create(null)
                        );
                    } else {
                        run_sync(
                            [
                                ShopifyAPI.delete_file(key),
                                Fs.unlink_file(min_local_path)
                            ],
                            function (data, reason) {
                                if (data === null) throw reason;
                                log("Deleted", key);
                                websocket.terminate();
                            },
                            Object.create(null)
                        );
                    }
                } else { //  Not a directory event
                    const path_parsed = path.parse(file_path);
                    const path_ext_name = path.extname(file_path);
                    const dir_path_parts = path_parsed.dir.split("/");
                    const file_dir = dir_path_parts[dir_path_parts.length - 1];
                    const module_is_file = (file_dir === "scripts");
                    let min_base;
                    if (module_is_file) {
                        min_base = path_parsed.base.replace(".js", ".min.js")
                    } else {
                        min_base = `${path.parse(path.dirname(file_path)).base}.min.js`
                    }
                    const key = `assets/${min_base}`;
                    if (
                        event === "change"
                        || event === "add"
                        || (
                            event === "unlink"
                            && module_is_file === false
                            && fs.existsSync(path_parsed.dir)
                        )
                    ) {
                        if (event === "add" && count > 1) return;
                        if (module_is_file === false) {
                            run_sync(
                                [
                                    Fs.get_all_file_paths(path_parsed.dir),
                                    process_js("from data", key)
                                ],
                                function (data, reason) {
                                    if (data === null) throw reason;
                                    log("Uploaded", key);
                                    websocket.terminate();
                                },
                                Object.create(null)
                            );
                        } else {
                            run_sync(
                                [
                                    process_js(file_path, key)
                                ],
                                function (data, reason) {
                                    if (data === null) throw reason;
                                    log("Uploaded", key);
                                    websocket.terminate();
                                },
                                Object.create(null)
                            );
                        }
                    }
                    if (event === "unlink" && module_is_file) {
                        run_sync(
                            [
                                ShopifyAPI.delete_file(key)
                            ],
                            function (data, reason) {
                                if (data === null) throw reason;
                                log("Deleted", key);
                                websocket.terminate();
                            },
                            Object.create(null)
                        );
                    }
                }
            } catch (exception) {
                log("Error", exception);
            }
        }
    }

    if (type === "styles") {
        return function update_styles_requestor(event, file_path) {
            try {
                const base_path = `${paths.styles}/main.scss`;
                const base_min_path = `${paths.theme}/assets/main.min.css.liquid`;
                if (
                    event === "change"
                    || event === "add"
                    || event === "unlink"
                ) {
                    run_sync(
                        [
                            Fs.process_scss(base_path, base_min_path),
                            ShopifyAPI.upload_file(base_min_path, "assets/main.min.css.liquid")
                        ],
                        function (data, reason) {
                            if (data === null) throw reason;
                            log("Uploaded", "assets/main.min.css.liquid");
                            websocket.terminate();
                        },
                        Object.create(null)
                    );
                }
            } catch (exception) {
                log("Error", exception);
            }
        }
    }

    return function update_theme_requestor(event, file_path) {
        try {
            const path_parsed = path.parse(file_path),
                  path_ext_name = path.extname(file_path),
                  dir_path_parts = path_parsed.dir.split("/"),
                  file_dir = dir_path_parts[dir_path_parts.length - 1];
            let theme_sub_dir,
                theme_dir;
//  Changing minified asset files will have no effect.
            if (
                file_dir === "assets"
                && path_parsed.base.includes(".min.")
            ) {
                return;
            }
//  Compute the path to upload the file to.
            let write_path,
                curr_path;
//  If the changed file is an immediate child of one of the main theme directories.
            if (theme_dirs.includes(file_dir)) {
                write_path = `${file_dir}/${path_parsed.base}`;
                curr_path = file_path;
            } else {
//  Subdirectories are expected to be limited to a depth of 1 within the theme directories,
//  Since the file was not an immediate child, it must be in an immediate subdirectory.
                theme_sub_dir = file_dir;
                theme_dir = dir_path_parts[dir_path_parts.length - 2];
//  customers/templates is a unique subdir in that it exists in the store admin codebase as well,
//  while all other theme subdirs are flattened into their respective theme dirs in the admin codebase.
                if (
                    theme_sub_dir === "customers"
                    && theme_dir === "templates"
                ) {
                    write_path = `templates/customers/${path_parsed.base}`;
                    curr_path = paths.theme + "/" + write_path;
                } else {
                    write_path = `${theme_dir}/${path_parsed.base}`;
                    curr_path = `${paths.theme}/${theme_dir}/${theme_sub_dir}/${path_parsed.base}`;
                }
            }
            if (event === "add" || event === "change") {
                const is_binary = non_string_formats.includes(path_parsed.ext);
                ShopifyAPI.upload_file(curr_path, write_path, is_binary)(
                    function (data, reason) {
                        if (data === null) throw reason;
                        log("Uploaded", write_path);
                        setTimeout(
                            function () {
                                websocket.terminate();
                            },
                            1500
                        );
                    },
                    Object.create(null)
                );
            }
            if (event === "unlink") {
                ShopifyAPI.delete_file(write_path)(
                    function (data, reason) {
                        if (data === null) throw reason;
                        log("Deleted", write_path);
                        websocket.terminate();
                    },
                    Object.create(null)
                );
            }
        } catch (exception) {
            log("Error", exception);
        }
    }
}


//  Used by update theme.
//  @param1 {string|array} input  -  A path to a js file or an array of them.
function process_js(input, key) {
    const upload_from = `${paths.theme}/${key}`;
    return function process_js_requestor(cb, data) {
        try {
            if (input === "from data") {
                input = data.files;
            }
            run_sync(
                [
                    Fs.minify_js(input, upload_from),
                    ShopifyAPI.upload_file(upload_from, key)
                ],
                cb,
                data
            );
        } catch (exception) {
            return cb(null, exception);
        }
    }
}
