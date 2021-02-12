"use strict";
const http = require("http");
const fs = require("fs");
const Path = require("path");
const https = require("https");
const WebSocket = require("ws");
const Fs = require("./requestor_factories/fs_operations");
const ShopifyAPI = require("./requestor_factories/api_requests");
const Utils = require("./utils");
const { run_sync, run_async } = Utils;
const { log } = require("./log");
const { create_data_object, data_objects_init } = require("./create_data_objects");
const Commands = require("./commands");
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
    ".ttc",
    ".gif",
    ".otf"
];
const theme_dirs = [
    "config",
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
paths.local_data = Path.join(__dirname, "local-data");


const start = function run_app(env_vars) {
    try {
        const data = Object.create(null);

        store_url = env_vars.store_url;
        store_preview_url = env_vars.store_preview_url;
        theme_id = env_vars.theme_id;
        auth = env_vars.auth;
        port = env_vars.port;

        paths.base = env_vars.base_path;
        paths.scripts = Path.join(paths.base, "scripts");
        paths.styles = Path.join(paths.base, "styles");
        paths.theme = Path.join(paths.base, "theme");
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
        log("Error", "start " + exception);
    }
};


//
// SHOPIFY REST ADMIN API OPERATIONS
// Getters
// Return a requestor function which takes a callback which it passes the
// data to once it has been retrieved.
//
const get_customer_by_id = function (env_vars, id, fields) {
	ShopifyAPI.init(env_vars);
	return ShopifyAPI.download_customer(id, fields);
};

const get_customers = function (env_vars, fields) {
	ShopifyAPI.init(env_vars);
	return ShopifyAPI.download_customers(fields);
};

const get_metafields = function (env_vars, resource_type, resource_id, namespace) {
	ShopifyAPI.init(env_vars);
	return ShopifyAPI.download_metafields(resource_type, resource_id, namespace);
};

const set_metafield = function (env_vars, resource_type, resource_id, request_body) {
	ShopifyAPI.init(env_vars);
	return ShopifyAPI.upload_metafield(resource_type, resource_id, request_body);
};

const get_products = function (env_vars, fields, query_string) {
    ShopifyAPI.init(env_vars);
    return ShopifyAPI.download_resource("product", fields, query_string);
};

const post_products = function (env_vars, json_objects) {
    ShopifyAPI.init(env_vars);
    return ShopifyAPI.upload_resource("product", json_objects, "PUT");
};


exports.deploy = Commands.Deploy;

exports.get_customer_by_id = get_customer_by_id;
exports.get_customers = get_customers;
exports.get_metafields = get_metafields;
exports.set_metafield = set_metafield;
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



function restart_socket(data, reason) {
    if (data === null) throw reason;
    if (data.log_type === "Upload Failed") {
      log(data.log_type, data.key);
      websocket.terminate();
    } else {
      log("Uploading", data.key);
      setTimeout(function () {
          log(data.log_type, data.key);
          websocket.terminate();
      }, 2000);
    }
}


function update_scripts() {
    let ignore_file_events = false;

    // Triggered by directory events.
    function start_delay() {
        ignore_file_events = true;
        setTimeout(function () {
          ignore_file_events = false;
        }, 1000);
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
            const path_parsed = Path.parse(file_path);

            if (event.includes("Dir")) {
                const dir_name = path_parsed.base;
                const key = `assets/${dir_name}.min.js`;
                data.key = key;
                const min_local_path = Path.join(paths.theme, key);

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

                return run_sync(requestors, restart_socket, data);
            }
        //  Assert:  This is not a directory event.
            const dir_path_parts = path_parsed.dir.split(Path.sep);
            const file_dir = dir_path_parts[dir_path_parts.length - 1];
            const module_is_file = (file_dir === "scripts" || file_dir === "templates");
            const min_base = (
                module_is_file
                ? path_parsed.base.replace(".js", ".min.js")
                : `${Path.parse(Path.dirname(file_path)).base}.min.js`
            );
            const key = `assets/${min_base}`;
            data.key = key;

            if (event === "unlink" && module_is_file) {
                const min_local_path = Path.join(paths.theme, key);
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
                return run_sync(requestors, restart_socket, data);
            }
        } catch (exception) {
            log("Error", exception);
        }
    }
}


function style_event_handler(event, file_path) {
    try {
        const base_path = Path.join(paths.styles, "main.scss");
        const base_min_path = Path.join(paths.theme, "assets", "main.min.css.liquid");
		const eventData = Object.create(null);
		eventData.key = "assets/main.min.css.liquid";
		eventData.log_type = "Uploaded";
        if (event === "change" || event === "add" || event === "unlink") {
            run_sync(
                [
                    Fs.process_scss(base_path, base_min_path),
                    ShopifyAPI.upload_file(base_min_path, "assets/main.min.css.liquid")
                ],
				restart_socket,
				eventData
            );
        }
    } catch (exception) {
        log("Error", exception);
    }
}


function theme_event_handler(event, file_path) {
    try {
        const path_parsed = Path.parse(file_path);
        const file_name = path_parsed.base;
        const dir_path_parts = path_parsed.dir.split(Path.sep);
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
                curr_path = Path.join(paths.theme, write_path);
            } else {
                write_path = `${theme_dir}/${path_parsed.base}`;
                curr_path = Path.join(paths.theme, theme_dir, theme_sub_dir, path_parsed.base);
            }
        }

		const eventData = Object.create(null);
		eventData.key = write_path;
		eventData.log_type = (event === "unlink") ? "Deleted" : "Uploaded";

//  Handle special cases cases then proceed with updating (adding or removing
//  the file from the Shopify server).
        if (file_path.includes(Path.join("snippets", "inline-scripts"))) {
            fs.readFile(file_path, "utf-8", function (err, results) {
                if (err) throw err;
                curr_path = Path.join(paths.local_data, file_name);
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
                        if (data === null) {
                          eventData.log_type = "Upload Failed";
                        }
                        if (delete_after) {
                            fs.unlink(curr_path, function (err) {
                                if (err) throw err;
                            });
                        }
						// log("Uploaded", write_path);
                        restart_socket(eventData);
                    },
                    Object.create(null)
                );
            }

            if (event === "unlink") {
                ShopifyAPI.delete_file(write_path)(function (data, reason) {
					if (data === null) {
						throw reason;
					}
					restart_socket(eventData);
				});
            }
        }
    } catch (exception) {
        log("Error", exception);
    }
}


//  Used by update theme.
//  @param1 {string|array} input  -  A path to a js file or an array of them.
function process_js(input, key) {
    const upload_from = Path.join(paths.theme, key);

    return function process_js_requestor(cb, data) {
        try {
    			const minifyAndUpload = function (filePaths) {
    				const requestors = [
    					Fs.minify_js(filePaths, upload_from),
    					ShopifyAPI.upload_file(upload_from, key)
    				];

    				return run_sync(requestors, cb, data);
    			};

          if (input === "from data") {
    				const moduleFilePaths = data.files;
    				const moduleFileNames = moduleFilePaths.map(function (p) {
    					let parts = p.split(Path.sep);
    					return parts[parts.length - 1];
    			 	});
    				if (moduleFileNames.includes("_script-order.js")) {
    					const filePathIndex = moduleFileNames.indexOf("_script-order.js");

    					fs.readFile(
    						moduleFilePaths[filePathIndex],
    						"utf8",
    						function (err, data) {
    							if (err) return cb(null, err);
    							const orderComment = data.match(/\/\*[\w\W]+\*\//g)[0];
    							let fileNames = orderComment.split("\n");
    							fileNames = fileNames.slice(1, fileNames.length - 1).map(name => name.trim() + ".js");
    							const filePaths = [];
    							fileNames.forEach(function (name) {
    								let moduleFileNameIndex = moduleFileNames.indexOf(name);
    								let moduleFilePath = moduleFilePaths[moduleFileNameIndex];
    								filePaths.push(moduleFilePath);
    							});
    							minifyAndUpload(filePaths);
    						}
    					);
    				} else {
    					minifyAndUpload(data.files);
    				}
          } else {
			      minifyAndUpload(input);
    			}
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
    const ws_script_path = Path.join(paths.base, "node_modules", "shopify_dev_utils", "websocket_insert_script.txt");
    run_sync(
        [
            ShopifyAPI.get_shopify_page_html(request.url),
            Fs.read_file(ws_script_path)
        ],
        function (data, reason) {
            if (data === null) throw reason;
            const html_file = Path.join(paths.base, "node_modules", "shopify_dev_utils", "store_page_content.html");
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
