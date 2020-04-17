//  The following requestors are used to modify the files for a Shopify theme.
//  author: Alex Moser
"use strict";
const fs = require("fs");
const https = require("https");
const Path = require("path");
const zlib = require("zlib");
const assert = require("assert");
const { run_sync, run_async } = require("../utils");
const dotenv = require("dotenv").config();
const { log } = require("../log");

let store_url;
let store_preview_url;
let theme_id;
let auth;
let port;

//  Module Private Methods
//  make_requestor()
//  Module Public Methods:
//  delete_file()
//  get_shopify_page_html()
//  upload_file()
//  upload_files()

//  download_products()
//  upload_products()

//  Shopify REST Admin API request reference for the "asset" resource type.
//  PUT
//      /admin/api/2019-10/themes/#{theme_id}/assets.json
//  DELETE
//      /admin/api/2019-10/themes/#{theme_id}/assets.json?asset[key]=assets/alex_is_cool.js
//  asset {
//      attachment: [a base64-encoded image],
//      key: assets/main.min.js,
//      value: The text content of the asset.
//  }

//  NOTES
//      For the Shopify REST admin API, any store can make a maximum of 40 requests
//  every 20 seconds. So here we keep track of that, and throttle accordingly.
//      We do not want to blanketly throttle all requests, for example one lazy solution
//  to avoid any overflow problems would be to not allow any more than 2 requests per second.
//  Since large batches of requests are probably not going to be coming in within 20 seconds
//  of each other very often, a better solution is to allow the bucket to fill up
//  as fast as it can, only throttling when necessary.

const api_version = "2020-01";
const base_path = "/admin/api/" + api_version;


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


// An integer representing the number of requests in the last 20 seconds.
let request_count = 0;

function add_request_to_bucket() {
    request_count += 1;
}

function remove_request_from_bucket() {
    request_count -= 1;
}

// An array of functions which, when called when start a request that had been throttled.
const overflow = [];
//  No more than 40 requests may exist in the bucket.
const bucket_size = 40;
//  Bucket loses two elements per second.
const leak_rate = 2;
//  We will treat 35 as the limit, so that outside requests or restarting the dev app
//  have less of a chance of causing a problem.
const padding = 5;
const bucket_limit = bucket_size - padding;
let is_polling = false;
let is_throttling = false;


//  When a request is added to the bucket, we start polling.  This means that until
//  the bucket is empty, every 1 / leak_rate seconds, we will reduce request count
//  by one.
function start_polling() {
    try {
        is_polling = true;
        (function poller() {
            setTimeout(
                function () {
                    if (request_count > 0)  {
                        return poller();
                    } else {
                        is_polling = false;
                    }
                },
                (1000 / leak_rate)
            );

            if (request_count > 0) {
                return remove_request_from_bucket();
            }
        })();
    } catch (exception) {
        log("Error", "poller error," + exception);
    }
}


//  When a function is added to the overflow array, we start the throttler.
//  The throttler takes the oldest start_request function from the overflow array
//  and triggers it, calling the throttler again in 1 / leak_rate seconds, to continue
//  the process until the overflow array is empty.
function start_throttling() {
    try {
        is_throttling = true;
        log("Chron Process Start", "Throttling");

        (function throttler() {
            setTimeout(
                function () {
                    if (overflow.length > 0)  {
                        return throttler();
                    } else {
                        is_throttling = false;
                        log("Chron Process Stop", "Throttling");
                    }
                },
                (1000 / leak_rate)
            );

            if (request_count < bucket_limit) {
                const next_request = overflow.shift();
                return next_request();
            }
        })();
    } catch (exception) {
        log("Error", "throttler error," + exception);
    }
}


function init(data) {
    store_url = data.store_url;
    store_preview_url = data.store_preview_url;
    theme_id = data.theme_id;
    auth = data.auth;
    port = data.port;
}


//  Creates the request options path.
function make_path(resource_type, query_string, resource_id = false) {
    let path = base_path;
    if (resource_type === "Asset") {
        path += `/themes/${theme_id}/assets.json`;
    } else if (resource_type === "Product") {
        if (resource_id) {
            path += `/products/${resource_id}.json`
        } else {
            path += "/products.json";
        }
    }

    path += query_string;
    return path;
}

function make_request_options(method, resource_type, query_string, resource_id) {
    const path = make_path(resource_type, query_string, resource_id);
    const options = {
        hostname: store_url,
        port: 443,
        path: path,
        method: method,
        auth: auth,
        headers: (method === "PUT" || method === "POST") ? {
            "Content-Type": "application/json"
        } : undefined
    };
    return options;
}

/*
    @param1 {string} method  -  The request method, e.g. "POST", "GET", etc.
    @param2 {string} resource_type  -  The type of API resource being targeted by
     the request, e.g. "Asset", "Product", "Metafield", etc.
    @param3 {object} request_data  -  (optional)  If a PUT or POST request is being
     made, then this should be the JSON object which will be stringified and sent
     as the request body.  Additionally, if a request which doesnt require a json request
     body, but does require a resource_id is being made, this should be a json object
     with only the id property, e.g. {"product":{"id":342432412}}.
    @return {function}  -  A requestor function which, when called, will make a request
    to the REST Admin API, and call its callback upon receiving a response.
*/
function make_requestor(method, resource_type, request_data, query_string="") {
    let resource_id;
    //  Determine if we are uploading a json object, as opposed to querying
    //  a particular resource.
    const is_upload = (method === "POST" || method === "PUT");

    if (resource_type === "Asset") {
        if (!is_upload) {
            query_string = `?asset[key]=${request_data["asset"].key}`;
        }
    } else if (resource_type === "Product") {
        if (method !== "POST" && request_data) {
            resource_id = request_data.request_data["id"];
        }
    }

    const options = make_request_options(method, resource_type, query_string, resource_id);

    return function requestor(cb, data) {
        try {
            const array = [];

            if (overflow.length === 0 && request_count < bucket_limit) { //  bucket is not full
                if (!is_polling) {
                    start_polling();
                }
                make_request();
            } else { //  bucket is full
                overflow.push(make_request);
                if (!is_throttling) {
                    return start_throttling();
                }
            }

            function make_request() {
                add_request_to_bucket();
                const request = https.request(options, function (response) {
                    if (response.statusCode.toString().charAt(0) !== "2") {
                        if (!options.path.includes("templates/customers")) {
                            console.log("statusCode: ", response.statusCode);
                        }
                    }
                    response.on("data", function (d) {
                        array.push(d);
                    });
                    response.on("end", function (err) {
                        if (err) throw err;
                        if (method === "GET") {
                            data.results = array.join("");
                        }
                        return cb(data);
                    });
                });
                request.on("error", function (err) {
                    log("Error", err);
                });
                if (method === "PUT" || method === "POST") {
                    request.write(JSON.stringify(request_data));
                }
                request.end();
            }

        } catch (exception) {
            return cb(null, "requestor " + exception);
        }
    }
}


// @param {string} key - e.g. "assets/my-font.woff2" or "templates/product.liquid".
// Async.
function delete_file(key) {
    return function delete_file_requestor(cb, data) {
        try {
            const request_data = { "asset": { "key": key } };
            return make_requestor("DELETE", "Asset", request_data)(cb, data);
        } catch (exception) {
            return cb(null, "delete_file " + exception);
        }
    }
}


//  1.  Makes a GET request to a Shopify store page.
//  2.  Unzip the response stream and write it to ../store_page_content.html.
//  3.  When our write stream emits the finished event, call the next function.
function get_shopify_page_html(req_path="/", is_redirect, location) {
    return function get_shopify_page_html_requestor(cb, data) {
        try {
            let hostname;
            if (is_redirect === true) {
                location = location.replace("https://", "");
                if (location.includes("/")) {
                    let url_array = location.split("/");
                    hostname = url_array[0];
                } else {
                    hostname = location;
                }
            } else {
                if (data.auth.store_preview_url !== undefined) {
                    hostname = data.auth.store_preview_url
                } else {
                    hostname = data.auth.store_url;
                }
            }
            const options = {
                method: "GET",
                hostname: hostname,
                path: req_path,
                port: 443,
                headers: {
                    "cache-control": "no-cache",
                    "Connection": "keep-alive",
                    "Accept-Encoding": "gzip, deflate",
                    "Host": hostname,
                    "Cache-Control": "no-cache",
                    "Accept": "*/*",
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36"
                }
            };
            const request = https.request(options, function (response) {
                // log("Request", {
                //     statusCode: response.statusCode,
                //     hostname: hostname,
                //     path: path
                // });
                if (response.statusCode === 301 || response.statusCode === 302) {
                    const location_header = response.headers.location;
                    const new_path = location_header.substring(location_header.indexOf(".com") + 4);

                    return get_shopify_page_html(new_path, true, location_header)(cb, data);
                } else {
                    const output_path = Path.join(
                        data.paths.base,
                        "node_modules",
                        "shopify_dev_utils",
                        "store_page_content.html"
                    );
                    const output = fs.createWriteStream(output_path);
                    output.on("finish", function () {
                        return cb(data);
                    });
//  Could we pipe output to the browser and just remove the zipping functionality?
//  For now, maybe it's best to just make sure we can do it using a slower method.
                    switch (response.headers["content-encoding"]) {
                    case "br":
                        response
                            .pipe(zlib.createBrotliDecompress())
                            .pipe(output);
                       break;
                    case "gzip":
                    case "deflate":
                        response
                           .pipe(zlib.createUnzip())
                           .pipe(output);
                           break;
                    default:
                        response.pipe(output);
                        break;
                    }
                }
            });
            request.on("error", function (error) {
                throw error;
            });
            request.end();
        } catch (exception) {
            return cb(null, exception);
        }
    }
};



// @param {string} path - e.g. "assets/my-font.woff2" or "templates/product.liquid".
// @param {boolean} is_binary - If the file content is not a string
//  (i.e. .jpg|.woff2|etc.) then we encode the content into base64 format prior
//  to sending it.
function upload_file(path, key, is_binary=false, sync=true, logResult=false) {
    return function upload_file_requestor(cb, data) {
        try {
            const file_encoding = is_binary ? "base64" : "utf-8";
            const value_type = is_binary ? "attachment" : "value";

            fs.readFile(path, file_encoding, function (err, content) {
                if (err) throw err;
                let request_data;

                if (is_binary) {
                    request_data = {
                        "asset": {
                            "key": key,
                            "attachment": content
                        }
                    };
                } else {
                    request_data = {
                        "asset": {
                            "key": key,
                            "value": content
                        }
                    };
                }

                make_requestor("PUT", "Asset", request_data)(
                    function (data, reason) {
                        if (data === null) throw reason;
                        if (sync) {
                            if (logResult) {
                                log("Uploaded", key);
                            }
                            return cb(data);
                        } else {
                            log("Uploaded", key);
                        }
                    },
                    data
                );
            });

            if (!sync) {
                return cb(data);
            }
        } catch (exception) {
            if (sync) {
                return cb(null, "upload_file " + exception);
            }
            log("Error", "upload_file " + exception);
        }
    }
}


//  read_from and write_to are arrays of strings.
function upload_files(readWriteMap) {
    return function upload_files_requestor(cb, data) {
        try {
            const requestors = [];

            for (let [readPath, writeKey] of readWriteMap) {
                const format = Path.parse(readPath).ext;
                const isBinary = non_string_formats.includes(format);
                requestors.push(upload_file(readPath, writeKey, isBinary, true, true));
            }
            // console.log(readWriteMap);
            run_async(
                requestors,
                function (data, reason) {
                    if (data === null) throw reason;
                    return cb(data);
                },
                Object.create(data)
            );
        } catch (exception) {
            return cb(null, exception);
        }
    }
}


function download_products(query_string) {
    return function download_products_requestor(cb, data) {
        try {
            return make_requestor("GET", "Product", null, query_string)(cb, data);
        } catch (exception) {
            return cb(null, exception);
        }
    }
}

// @param1 {object|array} json_objects  -  Can be a single product object to upload,
//  or an array of them.
function upload_products(json_objects) {
    return function upload_products_requestor(cb, data) {
        try {
            if (!Array.isArray(json_objects)) {
                return make_requestor("POST", "Product", json_objects)(cb, data);
            }
            const requestors = json_objects.map(object => make_requestor("POST", "Product", object));
            run_async(requestors, cb, data);
        } catch (exception) {
            return cb(null, exception);
        }
    }
}


exports.delete_file = delete_file;
exports.get_shopify_page_html = get_shopify_page_html;
exports.init = init;
exports.upload_file = upload_file;
exports.upload_files = upload_files;

exports.download_products = download_products;
exports.upload_products = upload_products;
