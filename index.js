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
paths.local_data = `${__dirname}/local-data`;


const start = function run_app(env_vars) {
    try {
        const data = Object.create(null);

        store_url = env_vars.store_url;
        store_preview_url = env_vars.store_preview_url;
        theme_id = env_vars.theme_id;
        auth = env_vars.auth;
        port = env_vars.port;

        paths.base = env_vars.base_path;
        paths.scripts = `${paths.base}/scripts`;
        paths.styles = `${paths.base}/styles`;
        paths.theme = `${paths.base}/theme`;
        data.paths = paths;

        ShopifyAPI.init(env_vars);

        // if local-data doesnt exist, make the directory,
        // and update the file scoped variable local_data_exists.
        if (!fs.existsSync(paths.local_data)) {
            fs.mkdirSync(paths.local_data, {});
        }

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



const get_products = function (env_vars, query_string) {
    ShopifyAPI.init(env_vars);

    ShopifyAPI.download_products(query_string)(
        function (data, reason) {
            if (data === null) {
                console.log("ERROR: ", reason);
            } else {
                console.log("Products downloaded successfully.");
                log("Product Data", JSON.parse(data.results.toString()).products);
            }
        },
        Object.create(null)
    );
};



const post_products = function (env_vars, product_data) {
    ShopifyAPI.init(env_vars);

    ShopifyAPI.upload_products(product_data)(
        function (data, reason) {
            if (data === null) {
                console.log("ERROR: ", reason);
            } else {
                console.log("Products uploaded successfully.");
            }
        },
        Object.create(null)
    );
};



exports.get_products = get_products;
exports.post_products = post_products;
exports.start = start;


//  Private Functions


function init_local_server() {
    return function init_server_requestor(cb, data) {
        try {
            server = http.createServer();
            server.listen(port);
            server.on("request", server_request_handler);
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
    return (
        type === "scripts" ? update_scripts()
        : type === "styles" ? style_event_handler
        : theme_event_handler
    );
}


function update_scripts() {
    let ignore_file_events = false;

    // Triggered by directory events.
    function start_delay() {
        ignore_file_events = true;
        setTimeout(
            function () {
                ignore_file_events = false;
            },
            1000
        );
    }

    function reload_socket(data, reason) {
        if (data === null) throw reason;
        log(data.log_type, data.key);
        setTimeout(
            function () {
                websocket.terminate();
            },
            1500
        );
    }

    return function script_event_handler(event, file_path) {
        try {
            if (event === "addDir" || event === "unlinkDir") {
                start_delay();
            }
            if (ignore_file_events && event === "add" || event === "unlink") {
                return;
            }
            //  Let requestors be an array of functions we will call in sequence.
            let requestors;
            //  Let data be the initial value object for the requestors sequence.
            const data = Object.create(null);
            const path_parsed = path.parse(file_path);
            if (event.includes("Dir")) {
                const dir_name = path_parsed.base;
                const key = `assets/${dir_name}.min.js`;
                data.key = key;
                const min_local_path = `${paths.theme}/${key}`;

                if (event === "addDir") {
                    requestors = [
                        Fs.get_all_file_paths(file_path),
                        process_js("from data", key)
                    ];
                    data.log_type = "Uploaded";

                } else {
                    requestors = [
                        ShopifyAPI.delete_file(key),
                        Fs.unlink_file(min_local_path)
                    ];
                    data.log_type = "Deleted";
                }

                return run_sync(requestors, reload_socket, data);
            }
        //  Assert:  This is not a directory event.
            const dir_path_parts = path_parsed.dir.split("/");
            const file_dir = dir_path_parts[dir_path_parts.length - 1];
            const module_is_file = (file_dir === "scripts");
            const min_base = (
                module_is_file
                ? path_parsed.base.replace(".js", ".min.js")
                : `${path.parse(path.dirname(file_path)).base}.min.js`
            );
            const key = `assets/${min_base}`;
            data.key = key;

            if (event === "unlink" && module_is_file) {
                const min_local_path = `${paths.theme}/${key}`;
                requestors = [
                    ShopifyAPI.delete_file(key),
                    Fs.unlink_file(min_local_path)
                ];
                data.log_type = "Deleted";

            } else if (event === "change" || event === "add" || event === "unlink") {
                data.log_type = "Uploaded";
                if (!module_is_file) {
                    requestors = [
                        Fs.get_all_file_paths(path_parsed.dir),
                        process_js("from data", key)
                    ];
                } else {
                    requestors = [ process_js(file_path, key) ];
                }
            }

            if (requestors.length > 0) {
                return run_sync(requestors, reload_socket, data);
            }
        } catch (exception) {
            log("Error", exception);
        }
    }
}


function style_event_handler(event, file_path) {
    try {
        const base_path = `${paths.styles}/main.scss`;
        const base_min_path = `${paths.theme}/assets/main.min.css.liquid`;
        if (event === "change" || event === "add" || event === "unlink") {
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


function theme_event_handler(event, file_path) {
    try {
        const path_parsed = path.parse(file_path);
        const file_name = path_parsed.base;
        const dir_path_parts = path_parsed.dir.split("/");
        const file_dir = dir_path_parts[dir_path_parts.length - 1];
//  Changing minified asset files will have no effect, but they can be deleted.
        if (
            file_dir === "assets"
            && file_name.includes(".min.")
            && !file_name.includes("-tr.min")
            && event !== "unlink"
        ) {
            return;
        }

//  Compute the following variables' values.
        let write_path;
        let curr_path;
        let theme_sub_dir;
        let theme_dir;

        if (theme_dirs.includes(file_dir)) {
            write_path = `${file_dir}/${file_name}`;
            curr_path = file_path;
        } else {
            theme_sub_dir = file_dir;
            theme_dir = dir_path_parts[dir_path_parts.length - 2];
            if (theme_sub_dir === "customers" && theme_dir === "templates") {
                write_path = `templates/customers/${path_parsed.base}`;
                curr_path = paths.theme + "/" + write_path;
            } else {
                write_path = `${theme_dir}/${path_parsed.base}`;
                curr_path = `${paths.theme}/${theme_dir}/${theme_sub_dir}/${path_parsed.base}`;
            }
        }

//  Handle special cases cases then proceed with updating (adding or removing
//  the file from the Shopify server).
        if (file_path.includes("snippets/inline-scripts")) {
            fs.readFile(file_path, "utf-8", function (err, results) {
                if (err) throw err;
                curr_path = `${paths.local_data}/${file_name}`;
                write_path = `snippets/${file_name}`;
                Fs.minify_js(file_path, curr_path)(
                    function (data, reason) {
                        if (data === null) throw reason;
                        return update_file(true);
                    },
                    Object.create(null)
                );
            })
        } else {
            update_file();
        }

        function update_file(delete_after=false) {
            if (event === "add" || event === "change") {
                const is_binary = non_string_formats.includes(path_parsed.ext);
                ShopifyAPI.upload_file(curr_path, write_path, is_binary)(
                    function (data, reason) {
                        if (data === null) throw reason;
                        log("Uploaded", write_path);
                        if (delete_after) {
                            fs.unlink(curr_path, function (err) {
                                if (err) throw err;
                            });
                        }
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
        }
    } catch (exception) {
        log("Error", exception);
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

            const requestors = [
                Fs.minify_js(input, upload_from),
                ShopifyAPI.upload_file(upload_from, key)
            ];

            return run_sync(requestors, cb, data);
        } catch (exception) {
            return cb(null, exception);
        }
    }
}


//  Handle requests to our local server.
//  1.  Request the store's HTML content.
//  2.  Get the text for the client side JS script.
//  3.  Append the script from #2 to the end of the body of the HTML from #1.
//  4.  Send the result of #3 to the client as a response to this request.
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
