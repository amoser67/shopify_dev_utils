// Modules
const fs = require("fs");
const Path = require("path");
const ShopifyAPI = require("./requestor_factories/api_requests");
const Fs = require("./requestor_factories/fs_operations");
const { log } = require("./log");
const { run_sync, run_async } = require("./utils");
const { create_data_object, data_objects_init } = require("./create_data_objects");

let base_path;
let theme_path;

// @purpose:  Upload local theme files to the store's theme.
// @param1 {array=} filenames - (optional) An array of theme file keys to upload,
//  if this param is undefined, then all theme files will be uploaded.
exports.Deploy = function (env_vars) {
    data_objects_init(env_vars)(function (data, reason) {
        if (data === null) throw reason;
    });

    const data = create_data_object("auth", "paths");
    base_path = data.paths.base;
    theme_path = data.paths.theme;

    data.readWriteMap = new Map();

    ShopifyAPI.init(env_vars);

    let themeDirs;

    // Build a map from local file paths to the server path/key.
    // This is needed, in part, because we allow a local directory structure
    // that is more robust than Shopify's theme directory structure.
    const buildMap = function (cb, data) {
        try {
            data.files.forEach(function (filename) {
                const keyPath = filename.replace(theme_path + Path.sep, "");
                const localKey = keyPath.replace(Path.sep, "/");
                let key;
                if (!localKey.includes("templates/customers")) {
                    const arr = localKey.split("/");
                    const newArr = [arr[0], arr[2] || arr[1]];
                    key = newArr.join("/");
                } else {
                    key = localKey;
                }
                if (key !== "config.yml/") {
                    data.readWriteMap.set(filename, key);
                }
            });
            console.log(data.readWriteMap);
            return cb(data);
        } catch (exception) {
            return cb(null, exception);
        }
    };

    run_sync([
        Fs.get_all_file_paths(theme_path),
        buildMap,
        ShopifyAPI.upload_files()
    ], function (data, reason) {
        if (data === null) throw reason;
        log("Deploy", "complete");
    }, data);
};
