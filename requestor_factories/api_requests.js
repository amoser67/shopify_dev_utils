//  The following requestors are used to modify the files for a Shopify theme.
//  author: Alex Moser
"use strict";
const fs = require("fs");
const https = require("https");
const path = require("path");
const zlib = require("zlib");
const assert = require("assert");
const { run_sync, run_async } = require("../utils");
const dotenv = require("dotenv").config();
const { log } = require("../log");


//  Module Public Methods:
//  delete_file()
//  get_shopify_page_html()
//  make_requestor()
//  upload_file()
//  upload_file_array()

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


const store_url = process.env.STORE_URL;
const theme_id = process.env.THEME_ID;
const auth = process.env.AUTH;


const api_version = "2020-01";
const base_path = "/admin/api/" + api_version + "/themes/";


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


//  Creates the request options path.
function make_path(theme_id, key, method) {
    let path = base_path;
    path += theme_id + "/assets.json";
    if (method !== "PUT") {
        path += "?asset[key]=" + key;
    }
    return path;
}


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



//  This returns a function which makes an API request to Shopify.
function make_requestor(
    method,
    key,
    value,
    value_type = "value"
) {
    return function requestor(cb, data) {
        try {
            const array = [];
            let put_data;

            if (value_type === "value") {
                put_data = JSON.stringify({
                    "asset": {
                        "key": key,
                        "value": value
                    }
                });
            } else if (value_type === "attachment") {
                put_data = JSON.stringify({
                    "asset": {
                        "key": key,
                        "attachment": value
                    }
                });
            }

            const options = {
                hostname: store_url,
                port: 443,
                path: make_path(theme_id, key, method),
                method: method,
                auth: auth,
                headers: (method === "PUT") ? {
                    "Content-Type": "application/json"
                } : undefined
            };

            if (overflow.length === 0 && request_count < bucket_limit) { //  bucket is not full
                if (is_polling === false) {
                    start_polling();
                }
                start_request();
            } else { //  bucket is full
                overflow.push(start_request);
                if (is_throttling === false) {
                    return start_throttling();
                }
            }

            function start_request() {
                add_request_to_bucket();
                const request = https.request(options, response => {
                    if (response.statusCode !== 200) {
                        if (key !== "templates/customers") {
                            console.log("statusCode: ", response.statusCode);
                            console.log("key: ", key);
                        }
                    }
                    response.on("data", d => {
                        array.push(d);
                    });
                    response.on("end", err => {
                        if (err) throw err;
                        return cb(data);
                    });
                });
                request.on("error", (err) => {
                    log("Error", err);
                });
                if (method === "PUT") {
                    request.write(put_data);
                }
                request.end();
            }
        } catch (exception) {
            return cb(null, "requestor " + exception);
        }
    }
}


// @param {string} path - e.g. "assets/my-font.woff2" or "templates/product.liquid".
// Async.
function delete_file(file_path) {
    return function delete_file_requestor(cb, data) {
        try {
            return make_requestor("DELETE", file_path)(cb, data);
        } catch (exception) {
            return cb(null, "delete_file " + exception);
        }
    }
}


//  1.  Makes a GET request to a Shopify store page.
//  2.  Unzip the response stream and write it to ../store_page_content.html.
//  3.  When our write stream emits the finished event, call the next function.
const get_shopify_page_html = function (path="/", is_redirect, location) {
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
                path: path,
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
                    const output = fs.createWriteStream(
                        `${data.paths.base}/node_modules/shopify_dev_utils/store_page_content.html`
                    );
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
function upload_file(path, key, is_binary=false, sync=true) {
    return function upload_file_requestor(cb, data) {
        try {
            const file_encoding = is_binary ? "base64" : "utf-8";
            const value_type = is_binary ? "attachment" : "value";

            fs.readFile(path, file_encoding, function (err, content) {
                if (err) throw err;
                make_requestor("PUT", key, content, value_type)(
                    function (data, reason) {
                        if (data === null) throw reason;
                        if (sync) {
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
function upload_file_array(read_from, write_to) {
    return function upload_file_array_requestor(cb, data) {
        try {
            if (read_from === "from data") {
                read_from = data.files;
                write_to = data.files.map(
                    name => name.replace(data.paths.theme + "/", "")
                );
            }
            const requestors = read_from.map(
                function(local_path, index) {
                    const format = path.parse(local_path).ext;
                    const is_binary = non_string_formats.includes(format);
                    return upload_file(
                        local_path,
                        write_to[index],
                        is_binary,
                        false
                    );
                }
            );
            run_async(
                requestors,
                function(data, reason) {
                    if (data === null) throw reason;
                    return cb(data);
                },
                create_data_object("auth")
            );
        } catch (exception) {
            return cb(null, exception);
        }
    }
}




exports.delete_file = delete_file;
exports.get_shopify_page_html = get_shopify_page_html;
exports.make_requestor = make_requestor;
exports.upload_file = upload_file;
exports.upload_file_array = upload_file_array;
